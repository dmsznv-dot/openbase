use fs2::FileExt;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use walkdir::WalkDir;

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Note {
    pub id: String,
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub properties: Value,
    pub links: Vec<String>,
    pub revision: String,
    pub updated: u64,
    pub excerpt: String,
    pub favorite: bool,
    pub parent_id: Option<String>,
    pub identity_conflict: bool,
}
#[derive(Clone, Serialize, Debug)]
pub struct Document {
    #[serde(flatten)]
    pub note: Note,
    pub content: String,
    pub raw: String,
    pub yaml_error: Option<String>,
}
impl std::ops::Deref for Document {
    type Target = Note;
    fn deref(&self) -> &Note {
        &self.note
    }
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TrashEntry {
    pub id: String,
    pub path: String,
    pub title: String,
    pub deleted: u64,
}
#[derive(Serialize, Clone)]
pub struct HistoryEntry {
    pub id: String,
    pub created: u64,
    pub size: u64,
}
pub struct Vault {
    pub root: PathBuf,
    db: Connection,
    _lock: File,
    cache: HashMap<String, (u128, u64, Note)>,
    snapshots: HashMap<String, u64>,
}

pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let rel = Path::new(relative);
    if rel.is_absolute()
        || rel.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Путь выходит за пределы хранилища".into());
    }
    let mut current = root.to_path_buf();
    for part in rel.components() {
        current.push(part.as_os_str());
        if current.exists() || fs::symlink_metadata(&current).is_ok() {
            let resolved = fs::canonicalize(&current).map_err(err)?;
            if !resolved.starts_with(root) {
                return Err("Символическая ссылка выходит за пределы хранилища".into());
            }
        }
    }
    Ok(root.join(rel))
}
fn parse(path: &str, raw: String, updated: u64) -> Document {
    let mut properties = json!({});
    let mut content = raw.clone();
    let mut yaml_error = None;
    if raw.starts_with("---\n") || raw.starts_with("---\r\n") {
        let normalized = raw.replace("\r\n", "\n");
        if let Some(end) = normalized[4..].find("\n---") {
            let end = end + 4;
            let after = end + 4;
            if normalized.as_bytes().get(after).is_none_or(|b| *b == b'\n') {
                match serde_yaml::from_str::<serde_yaml::Value>(&normalized[4..end]) {
                    Ok(v) => match serde_json::to_value(v) {
                        Ok(v) if v.is_object() || v.is_null() => {
                            properties = if v.is_null() { json!({}) } else { v };
                            content = normalized[after..].trim_start_matches('\n').to_string();
                        }
                        _ => yaml_error = Some("Frontmatter должен быть набором свойств".into()),
                    },
                    Err(e) => yaml_error = Some(e.to_string()),
                }
            } else {
                yaml_error = Some("Некорректная граница YAML".into());
            }
        } else {
            yaml_error = Some("Нет закрывающего разделителя YAML".into());
        }
    }
    let title = properties["title"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            Path::new(path)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });
    let tags = match &properties["tags"] {
        Value::Array(a) => a
            .iter()
            .filter_map(Value::as_str)
            .map(normalize_tag)
            .filter(|s| !s.is_empty())
            .collect(),
        Value::String(s) => s
            .split(',')
            .map(normalize_tag)
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    static INLINE: OnceLock<Regex> = OnceLock::new();
    let inline = INLINE.get_or_init(|| Regex::new(r"(?:^|\s)#([\p{L}\p{N}_/-]+)").unwrap());
    let mut tags: Vec<String> = tags;
    for c in inline.captures_iter(&content) {
        let t = normalize_tag(&c[1]);
        if !tags.contains(&t) {
            tags.push(t);
        }
    }
    let mut links = Vec::new();
    static WIKI: OnceLock<Regex> = OnceLock::new();
    let wiki = WIKI.get_or_init(|| Regex::new(r"\[\[([^\]]+)\]\]").unwrap());
    for c in wiki.captures_iter(&content) {
        links.push(c[1].to_string());
    }
    static MD: OnceLock<Regex> = OnceLock::new();
    let md = MD.get_or_init(|| Regex::new(r"(?:^|[^!])\[[^\]]*\]\(([^)]+)\)").unwrap());
    for c in md.captures_iter(&content) {
        if !c[1].contains("://") {
            links.push(c[1].to_string());
        }
    }
    let sys = &properties["localnotes"];
    let id = sys["id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("file:{}", hash(path.as_bytes())));
    let note = Note {
        id,
        path: path.into(),
        title,
        tags,
        links,
        revision: hash(raw.as_bytes()),
        updated,
        excerpt: content.chars().take(400).collect(),
        favorite: sys["favorite"].as_bool().unwrap_or(false),
        parent_id: sys["parent_id"].as_str().map(str::to_string),
        properties,
        identity_conflict: false,
    };
    Document {
        note,
        content,
        raw,
        yaml_error,
    }
}
fn normalize_tag(t: &str) -> String {
    t.trim().trim_start_matches('#').to_lowercase()
}
fn encode(content: &str, mut properties: Value) -> Result<String> {
    if !properties.is_object() {
        properties = json!({});
    }
    if !properties["localnotes"].is_object() {
        properties["localnotes"] = json!({});
    }
    if properties["localnotes"]["id"]
        .as_str()
        .is_none_or(|s| s.starts_with("file:"))
    {
        properties["localnotes"]["id"] = json!(Uuid::new_v4().to_string());
    }
    let yaml = serde_yaml::to_string(&properties).map_err(err)?;
    Ok(format!("---\n{}---\n\n{}", yaml, content))
}
fn decode_path(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
fn resolve_relative(source: &str, target: &str) -> Option<String> {
    let decoded = decode_path(target)?;
    if decoded.contains(":") || decoded.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = source.split('/').collect();
    parts.pop();
    for p in decoded.split('/') {
        if p == ".." {
            parts.pop()?;
        } else if p != "." && !p.is_empty() {
            parts.push(p);
        }
    }
    Some(parts.join("/"))
}
fn relative_to(source: &str, target: &str) -> String {
    let mut from: Vec<&str> = source.split('/').collect();
    from.pop();
    let to: Vec<&str> = target.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    format!(
        "{}{}",
        "../".repeat(from.len() - common),
        to[common..].join("/")
    )
}
fn rewrite_links(
    content: &str,
    source: &str,
    new_source: &str,
    old: &str,
    new: &str,
    title: &str,
    unique_stem: bool,
) -> String {
    let markdown = Regex::new(r"(!?\[[^\]]*\]\()([^)]+)(\))").unwrap();
    let text = markdown
        .replace_all(content, |c: &regex::Captures| {
            let href = &c[2];
            let (path, fragment) = href
                .split_once('#')
                .map(|(a, b)| (a, format!("#{}", b)))
                .unwrap_or((href, String::new()));
            let Some(target) = resolve_relative(source, path) else {
                return c[0].to_string();
            };
            let target = if target == old { new } else { &target };
            if source != new_source || target == new {
                format!(
                    "{}{}{}{}",
                    &c[1],
                    relative_to(new_source, target).replace(' ', "%20"),
                    fragment,
                    &c[3]
                )
            } else {
                c[0].to_string()
            }
        })
        .to_string();
    let wiki = Regex::new(r"\[\[([^\]]+)\]\]").unwrap();
    let old_stem = Path::new(old)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    wiki.replace_all(&text, |c: &regex::Captures| {
        let (target, label) = c[1]
            .split_once('|')
            .map(|(a, b)| (a, format!("|{}", b)))
            .unwrap_or((&c[1], String::new()));
        let (path, fragment) = target
            .split_once('#')
            .map(|(a, b)| (a, format!("#{}", b)))
            .unwrap_or((target, String::new()));
        if path == title {
            return c[0].to_string();
        }
        let resolved = resolve_relative(
            source,
            if path.ends_with(".md") {
                path
            } else {
                return if unique_stem && path == old_stem {
                    format!("[[{}{}{}]]", relative_to(new_source, new), fragment, label)
                } else {
                    c[0].to_string()
                };
            },
        );
        if resolved.as_deref() == Some(old) {
            format!("[[{}{}{}]]", relative_to(new_source, new), fragment, label)
        } else {
            c[0].to_string()
        }
    })
    .to_string()
}
impl Vault {
    pub fn open(root: &Path, index: &Path) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(|_| {
            "Папка недоступна. Подключите диск или выберите другую папку.".to_string()
        })?;
        if !root.is_dir() {
            return Err("Выберите папку".into());
        }
        for name in [
            ".localnotes",
            ".localnotes/history",
            ".localnotes/trash",
            ".localnotes/views",
            ".localnotes/conflicts",
        ] {
            let path = safe_path(&root, name)?;
            fs::create_dir_all(path).map_err(err)?;
        }
        let lock_path = safe_path(&root, ".localnotes/workspace.lock")?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(err)?;
        lock.try_lock_exclusive()
            .map_err(|_| "Это хранилище уже открыто другим экземпляром приложения".to_string())?;
        if let Some(parent) = index.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let db = Connection::open(index).map_err(err)?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, title TEXT, body TEXT, tags TEXT, data TEXT); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(path UNINDEXED,title,body,tags,tokenize='unicode61');").map_err(err)?;
        Ok(Self {
            root,
            db,
            _lock: lock,
            cache: HashMap::new(),
            snapshots: HashMap::new(),
        })
    }
    pub fn path(&self, path: &str) -> Result<PathBuf> {
        safe_path(&self.root, path)
    }
    fn note_path(&self, path: &str) -> Result<PathBuf> {
        if path.split('/').any(|p| p.starts_with('.')) || !path.to_lowercase().ends_with(".md") {
            return Err("Нужен Markdown-файл внутри хранилища".into());
        }
        self.path(path)
    }
    pub fn read(&self, path: &str) -> Result<Document> {
        let p = self.note_path(path)?;
        let raw = fs::read_to_string(&p).map_err(err)?;
        let updated = p
            .metadata()
            .map_err(err)?
            .modified()
            .map_err(err)?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Ok(parse(path, raw, updated))
    }
    fn index(&self, doc: &Document) -> Result<()> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO notes VALUES (?1,?2,?3,?4,?5)",
                params![
                    doc.path,
                    doc.title,
                    doc.content,
                    doc.tags.join(" "),
                    serde_json::to_string(&doc.note).map_err(err)?
                ],
            )
            .map_err(err)?;
        self.db
            .execute("DELETE FROM search WHERE path=?1", [&doc.path])
            .map_err(err)?;
        self.db
            .execute(
                "INSERT INTO search VALUES (?1,?2,?3,?4)",
                params![doc.path, doc.title, doc.content, doc.tags.join(" ")],
            )
            .map_err(err)?;
        Ok(())
    }
    pub fn list(&mut self) -> Result<Vec<Note>> {
        if !self.root.is_dir() {
            return Err("Хранилище недоступно. Проверьте подключение диска.".into());
        }
        let transaction = self.db.unchecked_transaction().map_err(err)?;
        let mut paths = HashSet::new();
        let mut notes = Vec::new();
        for entry in WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_file() || entry.path().extension().is_none_or(|e| e != "md") {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/");
            let Ok(meta) = entry.metadata() else { continue };
            let stamp = meta
                .modified()
                .map_err(err)?
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let len = meta.len();
            paths.insert(rel.clone());
            if let Some((old_stamp, old_len, n)) = self.cache.get(&rel) {
                if *old_stamp == stamp && *old_len == len {
                    notes.push(n.clone());
                    continue;
                }
            }
            match self.read(&rel) {
                Ok(doc) => {
                    self.index(&doc)?;
                    notes.push(doc.note.clone());
                    self.cache.insert(rel, (stamp, len, doc.note));
                }
                Err(_) => continue,
            }
        }
        let removed: Vec<String> = self
            .cache
            .keys()
            .filter(|p| !paths.contains(*p))
            .cloned()
            .collect();
        for p in removed {
            self.cache.remove(&p);
            self.db
                .execute("DELETE FROM notes WHERE path=?1", [&p])
                .map_err(err)?;
            self.db
                .execute("DELETE FROM search WHERE path=?1", [&p])
                .map_err(err)?;
        }
        let mut ids = HashMap::<String, usize>::new();
        for n in &notes {
            *ids.entry(n.id.clone()).or_default() += 1;
        }
        for n in &mut notes {
            if ids.get(&n.id).copied().unwrap_or(0) > 1 {
                n.identity_conflict = true;
                n.id = format!("duplicate:{}:{}", n.id, &hash(n.path.as_bytes())[..8]);
            }
        }
        notes.sort_by_key(|a| a.title.to_lowercase());
        transaction.commit().map_err(err)?;
        Ok(notes)
    }
    fn atomic(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let temp = path.with_file_name(format!(".write-{}", Uuid::new_v4()));
        let result = (|| {
            let mut f = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)
                .map_err(err)?;
            f.write_all(bytes).map_err(err)?;
            f.sync_all().map_err(err)?;
            fs::rename(&temp, path).map_err(err)?;
            if let Some(parent) = path.parent() {
                if let Ok(d) = File::open(parent) {
                    let _ = d.sync_all();
                }
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    fn snapshot(&mut self, path: &str, raw: &str, force: bool) -> Result<()> {
        if raw.is_empty() {
            return Ok(());
        }
        if !force
            && self
                .snapshots
                .get(path)
                .is_some_and(|last| now().saturating_sub(*last) < 60)
        {
            return Ok(());
        }
        let folder = format!(".localnotes/history/{}", hash(path.as_bytes()));
        let dir = self.path(&folder)?;
        fs::create_dir_all(&dir).map_err(err)?;
        let entries = self.history(path)?;
        if let Some(latest) = entries.first() {
            if fs::read(dir.join(&latest.id)).ok().as_deref() == Some(raw.as_bytes()) {
                return Ok(());
            }
        }
        let id = format!(
            "{:020}-{}.md",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            Uuid::new_v4()
        );
        self.atomic(&dir.join(id), raw.as_bytes())?;
        self.snapshots.insert(path.into(), now());
        self.prune_history(30 * 86400, 500 * 1024 * 1024)?;
        Ok(())
    }
    pub fn prune_history(&self, max_age: u64, budget: u64) -> Result<()> {
        let mut candidates = Vec::new();
        let mut total = 0u64;
        for folder in fs::read_dir(self.path(".localnotes/history")?).map_err(err)? {
            let folder = folder.map_err(err)?;
            if !folder.file_type().map_err(err)?.is_dir() {
                continue;
            }
            let mut files = Vec::new();
            for entry in fs::read_dir(folder.path()).map_err(err)? {
                let e = entry.map_err(err)?;
                if !e.file_type().map_err(err)?.is_file()
                    || e.path().extension().is_none_or(|x| x != "md")
                {
                    continue;
                }
                let name = e.file_name().to_string_lossy().to_string();
                let stamp = name
                    .split('-')
                    .next()
                    .and_then(|s| s.parse::<u128>().ok())
                    .unwrap_or(0);
                let seconds = if stamp > 10_000_000_000 {
                    (stamp / 1_000_000_000) as u64
                } else {
                    stamp as u64
                };
                let bytes = e.metadata().map_err(err)?.len();
                total += bytes;
                files.push((stamp, seconds, bytes, e.path()));
            }
            files.sort_by_key(|e| std::cmp::Reverse(e.0));
            candidates.extend(files.into_iter().skip(1));
        }
        candidates.sort_by_key(|e| e.0);
        for (_, created, bytes, path) in candidates {
            if now().saturating_sub(created) > max_age || total > budget {
                fs::remove_file(path).map_err(err)?;
                total = total.saturating_sub(bytes);
            }
        }
        Ok(())
    }
    pub fn save(
        &mut self,
        path: &str,
        expected: &str,
        content: &str,
        patch: Option<Value>,
    ) -> Result<Document> {
        let old = self.read(path)?;
        if old.revision != expected {
            let conflict = self.path(&format!(".localnotes/conflicts/{}.md", Uuid::new_v4()))?;
            self.atomic(&conflict, content.as_bytes())?;
            return Err(
                "CONFLICT: Файл изменён другой программой. Ваша версия сохранена отдельно.".into(),
            );
        }
        if old.yaml_error.is_some() {
            return Err(
                "Некорректный YAML. Исправьте полный исходник перед визуальным редактированием."
                    .into(),
            );
        }
        let mut props = old.properties.clone();
        if let Some(patch) = patch {
            if let Some(map) = patch.as_object() {
                for (k, v) in map {
                    if k == "localnotes" {
                        if let Some(obj) = v.as_object() {
                            if !props[k].is_object() {
                                props[k] = json!({});
                            }
                            for (sk, sv) in obj {
                                if sk != "id" {
                                    props[k][sk] = sv.clone();
                                }
                            }
                        }
                    } else {
                        props[k] = v.clone();
                    }
                }
            }
        }
        let raw = encode(content, props)?;
        self.snapshot(path, &old.raw, false)?;
        let p = self.note_path(path)?;
        if hash(&fs::read(&p).map_err(err)?) != expected {
            return Err(
                "CONFLICT: Файл меняется во время сохранения. Черновик остаётся в редакторе."
                    .into(),
            );
        }
        self.atomic(&p, raw.as_bytes())?;
        let doc = self.read(path)?;
        self.index(&doc)?;
        self.cache.remove(path);
        Ok(doc)
    }
    pub fn move_note(
        &mut self,
        old_path: &str,
        new_path: &str,
        expected: &str,
    ) -> Result<Document> {
        let old = self.read(old_path)?;
        if old.revision != expected {
            return Err("CONFLICT: Страница изменилась".into());
        }
        if old_path == new_path {
            return Ok(old);
        }
        let dest = self.note_path(new_path)?;
        let notes = self.list()?;
        if dest.exists()
            || notes
                .iter()
                .any(|n| n.path.to_lowercase() == new_path.to_lowercase())
        {
            return Err("Такой путь уже занят".into());
        }
        let stem = Path::new(old_path).file_stem().unwrap_or_default();
        let unique = notes
            .iter()
            .filter(|n| Path::new(&n.path).file_stem() == Some(stem))
            .count()
            == 1;
        let mut changes = Vec::new();
        for n in notes {
            let d = self.read(&n.path)?;
            let new_source = if n.path == old_path {
                new_path
            } else {
                &n.path
            };
            let body = rewrite_links(
                &d.content, &n.path, new_source, old_path, new_path, &old.title, unique,
            );
            if n.path == old_path || body != d.content {
                if d.yaml_error.is_some() {
                    return Err(format!("Сначала исправьте YAML: {}", n.path));
                }
                changes.push((d, body));
            }
        }
        let record = self.path(&format!(".localnotes/moves/{}.json", Uuid::new_v4()))?;
        self.atomic(&record,&serde_json::to_vec(&json!({"from":old_path,"to":new_path,"originals":changes.iter().map(|(d,_)|json!({"path":d.path,"raw":d.raw})).collect::<Vec<_>>()})).map_err(err)?)?;
        let body = changes
            .iter()
            .find(|(d, _)| d.path == old_path)
            .map(|(_, body)| body.as_str())
            .unwrap_or(&old.content);
        let new_raw = encode(body, old.properties.clone())?;
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p).map_err(err)?;
        }
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&dest)
            .map_err(err)?;
        f.write_all(new_raw.as_bytes()).map_err(err)?;
        f.sync_all().map_err(err)?;
        self.snapshot(old_path, &old.raw, true)?;
        for (d, body) in &changes {
            if d.path != old_path {
                self.save(&d.path, &d.revision, body, None).map_err(|e| {
                    format!("Перемещение сохраняет обе копии; проверьте ссылки. {}", e)
                })?;
            }
        }
        if self.read(old_path)?.revision != expected {
            return Err("CONFLICT: Исходный файл меняется. Обе копии сохранены.".into());
        }
        fs::remove_file(self.note_path(old_path)?).map_err(err)?;
        self.cache.remove(old_path);
        self.db
            .execute("DELETE FROM notes WHERE path=?1", [old_path])
            .map_err(err)?;
        self.db
            .execute("DELETE FROM search WHERE path=?1", [old_path])
            .map_err(err)?;
        let moved = self.read(new_path)?;
        self.index(&moved)?;
        fs::remove_file(record).map_err(err)?;
        Ok(moved)
    }
    pub fn repair_identity(&mut self, path: &str, expected: &str) -> Result<Document> {
        let old = self.read(path)?;
        if old.revision != expected {
            return Err("CONFLICT: Файл изменён другой программой".into());
        }
        if old.yaml_error.is_some() {
            return Err("Сначала исправьте YAML".into());
        }
        let mut props = old.properties.clone();
        if !props["localnotes"].is_object() {
            props["localnotes"] = json!({});
        }
        props["localnotes"]["id"] = json!(Uuid::new_v4().to_string());
        self.snapshot(path, &old.raw, true)?;
        self.atomic(
            &self.note_path(path)?,
            encode(&old.content, props)?.as_bytes(),
        )?;
        let d = self.read(path)?;
        self.cache.remove(path);
        self.index(&d)?;
        Ok(d)
    }
    pub fn save_raw(&mut self, path: &str, expected: &str, raw: &str) -> Result<Document> {
        let old = self.read(path)?;
        if old.revision != expected {
            return Err("CONFLICT: Файл изменён другой программой".into());
        }
        self.snapshot(path, &old.raw, true)?;
        self.atomic(&self.note_path(path)?, raw.as_bytes())?;
        let doc = self.read(path)?;
        self.index(&doc)?;
        self.cache.remove(path);
        Ok(doc)
    }
    pub fn create(&mut self, title: &str, parent: Option<String>) -> Result<Document> {
        let title = if title.trim().is_empty() {
            "Без названия"
        } else {
            title.trim()
        };
        let name: String = title
            .chars()
            .map(|c| {
                if c == '/' || c == '\\' || c == ':' || c.is_control() {
                    '_'
                } else {
                    c
                }
            })
            .take(100)
            .collect();
        let name = name.trim_matches('.');
        let name = if name.is_empty() {
            "Страница"
        } else {
            name
        };
        let mut path = format!("{}.md", name);
        let existing: HashSet<String> =
            self.list()?.iter().map(|n| n.path.to_lowercase()).collect();
        if existing.contains(&path.to_lowercase()) {
            path = format!("{}-{}.md", name, &Uuid::new_v4().to_string()[..8]);
        }
        let raw = encode(
            "",
            json!({"title":title,"tags":[],"status":"Без статуса","localnotes":{"id":Uuid::new_v4().to_string(),"parent_id":parent}}),
        )?;
        let p = self.note_path(&path)?;
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(p)
            .map_err(err)?;
        f.write_all(raw.as_bytes()).map_err(err)?;
        f.sync_all().map_err(err)?;
        let doc = self.read(&path)?;
        self.index(&doc)?;
        Ok(doc)
    }
    pub fn trash(&mut self, path: &str) -> Result<String> {
        let doc = self.read(path)?;
        let id = Uuid::new_v4().to_string();
        let target = self.path(&format!(".localnotes/trash/{}.md", id))?;
        let item = TrashEntry {
            id: id.clone(),
            path: path.into(),
            title: doc.title.clone(),
            deleted: now(),
        };
        let meta = self.path(&format!(".localnotes/trash/{}.json", id))?;
        self.atomic(&meta, &serde_json::to_vec(&item).map_err(err)?)?;
        fs::rename(self.note_path(path)?, target).map_err(err)?;
        self.cache.remove(path);
        self.db
            .execute("DELETE FROM notes WHERE path=?1", [path])
            .map_err(err)?;
        self.db
            .execute("DELETE FROM search WHERE path=?1", [path])
            .map_err(err)?;
        Ok(id)
    }
    fn uuid(id: &str) -> Result<()> {
        Uuid::parse_str(id).map(|_| ()).map_err(err)
    }
    pub fn trash_list(&self) -> Result<Vec<TrashEntry>> {
        let mut out = Vec::new();
        for e in fs::read_dir(self.path(".localnotes/trash")?).map_err(err)? {
            let e = e.map_err(err)?;
            if e.path().extension().is_some_and(|x| x == "json") {
                if let Ok(item) =
                    serde_json::from_slice::<TrashEntry>(&fs::read(e.path()).map_err(err)?)
                {
                    if self
                        .path(&format!(".localnotes/trash/{}.md", item.id))?
                        .exists()
                    {
                        out.push(item);
                    }
                }
            }
        }
        out.sort_by_key(|x| std::cmp::Reverse(x.deleted));
        Ok(out)
    }
    pub fn restore(&mut self, id: &str) -> Result<Document> {
        Self::uuid(id)?;
        let item: TrashEntry = serde_json::from_slice(
            &fs::read(self.path(&format!(".localnotes/trash/{}.json", id))?).map_err(err)?,
        )
        .map_err(err)?;
        let dest = self.note_path(&item.path)?;
        if dest.exists() {
            return Err("Путь занят другой заметкой. Переместите её перед восстановлением.".into());
        }
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p).map_err(err)?;
        }
        fs::hard_link(self.path(&format!(".localnotes/trash/{}.md", id))?, &dest).map_err(err)?;
        fs::remove_file(self.path(&format!(".localnotes/trash/{}.md", id))?).map_err(err)?;
        fs::remove_file(self.path(&format!(".localnotes/trash/{}.json", id))?).map_err(err)?;
        let doc = self.read(&item.path)?;
        self.index(&doc)?;
        Ok(doc)
    }
    pub fn history(&self, path: &str) -> Result<Vec<HistoryEntry>> {
        self.note_path(path)?;
        let dir = self.path(&format!(".localnotes/history/{}", hash(path.as_bytes())))?;
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        for e in fs::read_dir(dir).map_err(err)? {
            let e = e.map_err(err)?;
            let id = e.file_name().to_string_lossy().to_string();
            if !id.ends_with(".md") {
                continue;
            }
            let stamp = id
                .split('-')
                .next()
                .and_then(|s| s.parse::<u128>().ok())
                .unwrap_or(0);
            let created = if stamp > 10_000_000_000 {
                (stamp / 1_000_000_000) as u64
            } else {
                stamp as u64
            };
            entries.push(HistoryEntry {
                id,
                created,
                size: e.metadata().map_err(err)?.len(),
            });
        }
        entries.sort_by(|a, b| {
            let stamp = |s: &str| {
                s.split('-')
                    .next()
                    .and_then(|s| s.parse::<u128>().ok())
                    .unwrap_or(0)
            };
            stamp(&b.id).cmp(&stamp(&a.id))
        });
        Ok(entries)
    }
    pub fn restore_history(&mut self, path: &str, id: &str, expected: &str) -> Result<Document> {
        if id.contains('/') || id.contains('\\') || !self.history(path)?.iter().any(|h| h.id == id)
        {
            return Err("Версия не найдена".into());
        }
        let old = self.read(path)?;
        if old.revision != expected {
            return Err("CONFLICT: Сначала обновите страницу".into());
        }
        let raw = fs::read_to_string(self.path(&format!(
            ".localnotes/history/{}/{}",
            hash(path.as_bytes()),
            id
        ))?)
        .map_err(err)?;
        self.snapshot(path, &old.raw, true)?;
        self.save_raw(path, expected, &raw)
    }
    pub fn attach(&self, source: &Path) -> Result<String> {
        self.attach_with_progress(source, &AtomicBool::new(false), |_, _| {})
    }
    pub fn attach_with_progress(
        &self,
        source: &Path,
        cancel: &AtomicBool,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<String> {
        let original = source
            .file_name()
            .ok_or("Не задано имя файла")?
            .to_string_lossy();
        let clean: String = original
            .chars()
            .map(|c| {
                if c == '/' || c == '\\' || c.is_control() {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        let rel = format!("Вложения/{}-{}", &Uuid::new_v4().to_string()[..8], clean);
        let dest = self.path(&rel)?;
        let parent = dest.parent().unwrap();
        fs::create_dir_all(parent).map_err(err)?;
        let temp = parent.join(format!(".upload-{}", Uuid::new_v4()));
        let result = (|| {
            let mut src = File::open(source).map_err(err)?;
            if !src.metadata().map_err(err)?.is_file() {
                return Err("Нужен обычный файл".into());
            }
            let mut out = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)
                .map_err(err)?;
            let total = src.metadata().map_err(err)?.len();
            let mut copied = 0;
            let mut buffer = vec![0u8; 1024 * 1024];
            progress(0, total);
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Загрузка отменена".into());
                }
                let read = src.read(&mut buffer).map_err(err)?;
                if read == 0 {
                    break;
                }
                out.write_all(&buffer[..read]).map_err(err)?;
                copied += read as u64;
                progress(copied, total);
            }
            out.sync_all().map_err(err)?;
            fs::rename(&temp, &dest).map_err(err)?;
            Ok(rel)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }
    pub fn search(&mut self, query: &str) -> Result<Vec<Note>> {
        self.list()?;
        let query = query
            .split_whitespace()
            .filter_map(|w| {
                let word: String = w.chars().filter(|c| c.is_alphanumeric()).collect();
                if word.is_empty() {
                    None
                } else {
                    Some(format!("\"{}\"*", word))
                }
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        if query.is_empty() {
            return self.list();
        }
        let mut stmt=self.db.prepare("SELECT notes.data FROM search JOIN notes ON notes.path=search.path WHERE search MATCH ?1 ORDER BY bm25(search,0,5,1,1) LIMIT 200").map_err(err)?;
        let rows = stmt
            .query_map([query], |r| r.get::<_, String>(0))
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row.map_err(err)?).map_err(err)?);
        }
        Ok(out)
    }
    pub fn rebuild(&mut self) -> Result<()> {
        self.db
            .execute_batch("DELETE FROM notes;DELETE FROM search;")
            .map_err(err)?;
        self.cache.clear();
        self.list()?;
        Ok(())
    }
    pub fn load_views(&self) -> Result<Value> {
        let p = self.path(".localnotes/views/workspace.yaml")?;
        if !p.exists() {
            return Ok(json!([]));
        }
        let text = fs::read_to_string(p).map_err(err)?;
        serde_yaml::from_str(&text).map_err(err)
    }
    pub fn save_views(&self, views: &Value) -> Result<()> {
        if !views.is_array() {
            return Err("Нужен список представлений".into());
        }
        self.atomic(
            &self.path(".localnotes/views/workspace.yaml")?,
            serde_yaml::to_string(views).map_err(err)?.as_bytes(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn vault() -> (TempDir, Vault) {
        let dir = TempDir::new().unwrap();
        let v = Vault::open(dir.path(), &dir.path().join("index.sqlite")).unwrap();
        (dir, v)
    }
    #[test]
    fn save_detects_external_change_and_preserves_both() {
        let (dir, mut v) = vault();
        let n = v.create("Идея", None).unwrap();
        let disk = dir.path().join(&n.path);
        std::fs::write(&disk, "external change").unwrap();
        assert!(v
            .save(&n.path, &n.revision, "my draft", None)
            .unwrap_err()
            .starts_with("CONFLICT:"));
        assert_eq!(std::fs::read_to_string(disk).unwrap(), "external change");
    }
    #[test]
    fn markdown_reopens_and_properties_are_preserved() {
        let (dir, mut v) = vault();
        std::fs::write(
            dir.path().join("old.md"),
            "---\ncustom:\n  keep: 42\ntags: [project]\n---\nOriginal",
        )
        .unwrap();
        let n = v.read("old.md").unwrap();
        let n = v
            .save(
                "old.md",
                &n.revision,
                "Updated",
                Some(serde_json::json!({"status":"Ready"})),
            )
            .unwrap();
        assert_eq!(n.content, "Updated");
        assert_eq!(n.properties["custom"]["keep"], 42);
        assert_eq!(v.read("old.md").unwrap().tags, vec!["project"]);
    }
    #[test]
    fn page_views_preserve_markdown_attachments_and_parent_after_reopening() {
        let (dir, mut v) = vault();
        let parent = v.create("Проект", Some("root".into())).unwrap();
        let child = v.create("Задача", Some(parent.id.clone())).unwrap();
        let media = b"original attachment bytes";
        fs::create_dir_all(dir.path().join("Вложения")).unwrap();
        fs::write(dir.path().join("Вложения/brief.pdf"), media).unwrap();
        let content = "# Описание\n\n[Бриф](Вложения/brief.pdf)\n\nТекст проекта.";
        let mut page = v
            .save(&parent.path, &parent.revision, content, None)
            .unwrap();
        for layout in ["table", "board", "cards", "text"] {
            page = v.save(&page.path, &page.revision, &page.content,
                Some(json!({"localnotes": {"page_view": {
                    "layout": layout, "tags": [], "match": "any", "sort": "title", "groupBy": "status"
                }}}))).unwrap();
        }
        page = v
            .save(
                &page.path,
                &page.revision,
                &page.content,
                Some(json!({"localnotes": {"favorite": true}})),
            )
            .unwrap();
        let path = page.path.clone();
        drop(v);
        let v = Vault::open(dir.path(), &dir.path().join("index.sqlite")).unwrap();
        let reopened = v.read(&path).unwrap();
        assert_eq!(reopened.content, content);
        assert_eq!(reopened.id, parent.id);
        assert_eq!(reopened.parent_id.as_deref(), Some("root"));
        assert!(reopened.favorite);
        assert_eq!(
            reopened.properties["localnotes"]["page_view"]["layout"],
            "text"
        );
        assert_eq!(
            v.read(&child.path).unwrap().parent_id.as_deref(),
            Some(parent.id.as_str())
        );
        assert_eq!(
            fs::read(dir.path().join("Вложения/brief.pdf")).unwrap(),
            media
        );
    }
    #[test]
    fn traversal_and_escaping_symlinks_are_rejected() {
        let (dir, v) = vault();
        assert!(v.read("../outside.md").is_err());
        let outside = TempDir::new().unwrap();
        std::fs::write(outside.path().join("secret.md"), "secret").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), dir.path().join("escape")).unwrap();
            assert!(v.read("escape/secret.md").is_err());
        }
    }
    #[test]
    fn trash_restore_collision_never_overwrites() {
        let (dir, mut v) = vault();
        let n = v.create("Страница", None).unwrap();
        let item = v.trash(&n.path).unwrap();
        std::fs::write(dir.path().join(&n.path), "replacement").unwrap();
        assert!(v.restore(&item).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(&n.path)).unwrap(),
            "replacement"
        );
    }
    #[test]
    fn malformed_yaml_is_readable_but_cannot_be_silently_rewritten() {
        let (dir, mut v) = vault();
        std::fs::write(dir.path().join("bad.md"), "---\ntags: [\n---\nkeep text").unwrap();
        let n = v.read("bad.md").unwrap();
        assert!(n.yaml_error.is_some());
        assert!(v.save("bad.md", &n.revision, "new", None).is_err());
    }
    #[test]
    fn move_updates_relative_links_and_preserves_media_targets() {
        let (dir, mut v) = vault();
        fs::write(
            dir.path().join("A.md"),
            "---\ntitle: A\n---\n![ref](Вложения/a.png)",
        )
        .unwrap();
        fs::write(dir.path().join("B.md"), "[A](A.md)").unwrap();
        let a = v.read("A.md").unwrap();
        let moved = v.move_note("A.md", "Folder/A.md", &a.revision).unwrap();
        assert!(moved.content.contains("../Вложения/a.png"));
        assert!(v.read("B.md").unwrap().content.contains("Folder/A.md"));
        assert!(!dir.path().join("A.md").exists());
        assert!(dir.path().join("Folder/A.md").exists());
    }
    #[test]
    fn cancelled_copy_does_not_publish_partial_media() {
        let (dir, v) = vault();
        let source = TempDir::new().unwrap();
        let p = source.path().join("large.bin");
        fs::write(&p, vec![1u8; 2 * 1024 * 1024]).unwrap();
        let cancel = AtomicBool::new(true);
        assert!(v.attach_with_progress(&p, &cancel, |_, _| {}).is_err());
        let attachments = dir.path().join("Вложения");
        assert!(fs::read_dir(attachments).unwrap().next().is_none());
    }
    #[test]
    fn duplicate_id_is_detected_and_can_be_repaired_without_changing_body() {
        let (dir, mut v) = vault();
        for name in ["A.md", "B.md"] {
            fs::write(
                dir.path().join(name),
                "---\nlocalnotes:\n  id: duplicate\n---\nKeep body",
            )
            .unwrap();
        }
        let all = v.list().unwrap();
        assert_ne!(all[0].id, all[1].id);
        let n = v.read("B.md").unwrap();
        let repaired = v.repair_identity("B.md", &n.revision).unwrap();
        assert_eq!(repaired.content, "Keep body");
        assert_ne!(repaired.id, "duplicate");
    }
    #[test]
    fn history_pruning_keeps_latest_snapshot_for_each_note() {
        let (_dir, mut v) = vault();
        let n = v.create("Retention", None).unwrap();
        let dir = v
            .path(&format!(".localnotes/history/{}", hash(n.path.as_bytes())))
            .unwrap();
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("1-old.md"), "old").unwrap();
        fs::write(dir.join("2-latest.md"), "latest").unwrap();
        v.prune_history(30 * 86400, 1).unwrap();
        assert!(!dir.join("1-old.md").exists());
        assert!(dir.join("2-latest.md").exists());
    }
    #[test]
    fn restoring_history_keeps_the_current_version() {
        let (_dir, mut v) = vault();
        let n = v.create("История", None).unwrap();
        let n = v.save(&n.path, &n.revision, "First", None).unwrap();
        let n = v.save(&n.path, &n.revision, "Second", None).unwrap();
        let entries = v.history(&n.path).unwrap();
        let old = entries.last().unwrap().id.clone();
        v.restore_history(&n.path, &old, &n.revision).unwrap();
        let versions = v.history(&n.path).unwrap();
        let folder = v
            .path(&format!(".localnotes/history/{}", hash(n.path.as_bytes())))
            .unwrap();
        assert!(versions
            .iter()
            .any(|h| fs::read_to_string(folder.join(&h.id))
                .unwrap()
                .contains("Second")));
    }
    #[test]
    fn metadata_changes_do_not_drop_pending_properties() {
        let (_dir, mut v) = vault();
        let n = v.create("Test", None).unwrap();
        let n = v
            .save(
                &n.path,
                &n.revision,
                "",
                Some(json!({"localnotes":{"favorite":true},"tags":["project"]})),
            )
            .unwrap();
        let n = v
            .save(
                &n.path,
                &n.revision,
                "text",
                Some(json!({"localnotes":{"parent_id":"parent"}})),
            )
            .unwrap();
        assert!(n.favorite);
        assert_eq!(n.tags, vec!["project"]);
        assert_eq!(n.parent_id.as_deref(), Some("parent"));
    }
    #[test]
    #[ignore = "release performance and large-file verification"]
    fn benchmark_large_vault_and_attachment() {
        let (dir, mut v) = vault();
        for i in 0..100 {
            fs::write(dir.path().join(format!("note-{i}.md")),format!("---\ntitle: Page {i}\ntags: [project]\n---\nA prototype material светильник {i}\n")).unwrap();
        }
        let start = std::time::Instant::now();
        assert_eq!(v.list().unwrap().len(), 100);
        println!("Initial index 100: {:?}", start.elapsed());
        let mut samples = Vec::new();
        for _ in 0..20 {
            let t = std::time::Instant::now();
            assert!(!v.search("свет").unwrap().is_empty());
            samples.push(t.elapsed().as_millis());
        }
        samples.sort();
        println!("Search p95 incl file scan: {}ms", samples[18]);
        let big = dir.path().join("big-source.bin");
        let f = File::create(&big).unwrap();
        f.set_len(2 * 1024 * 1024 * 1024 + 1).unwrap();
        drop(f);
        let t = std::time::Instant::now();
        let dest = v.attach(&big).unwrap();
        assert_eq!(
            fs::metadata(dir.path().join(dest)).unwrap().len(),
            2 * 1024 * 1024 * 1024 + 1
        );
        println!("Copy >2GiB: {:?}", t.elapsed());
    }
    #[test]
    fn attachment_is_copied_and_index_can_be_rebuilt() {
        let (dir, mut v) = vault();
        let source = TempDir::new().unwrap();
        std::fs::write(source.path().join("asset.bin"), vec![17u8; 1048577]).unwrap();
        let path = v.attach(&source.path().join("asset.bin")).unwrap();
        assert_eq!(
            std::fs::metadata(dir.path().join(path)).unwrap().len(),
            1048577
        );
        let n = v.create("Тест поиска", None).unwrap();
        v.save(&n.path, &n.revision, "Светильник prototype", None)
            .unwrap();
        assert_eq!(v.search("свет").unwrap().len(), 1);
        assert_eq!(v.search("prot").unwrap().len(), 1);
        v.rebuild().unwrap();
        assert_eq!(v.list().unwrap().len(), 1);
    }
}
