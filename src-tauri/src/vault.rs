use serde::{Serialize, Deserialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs::{self, File, OpenOptions}, io::Write, path::{Path, PathBuf, Component}, time::{SystemTime, UNIX_EPOCH}};
use fs2::FileExt;
use rusqlite::{Connection, params};
use uuid::Uuid;
use walkdir::WalkDir;
use regex::Regex;

type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() }
fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Note { pub id:String, pub path:String, pub title:String, pub tags:Vec<String>, pub properties:Value, pub links:Vec<String>, pub revision:String, pub updated:u64, pub excerpt:String, pub favorite:bool, pub parent_id:Option<String> }
#[derive(Clone, Serialize, Debug)]
pub struct Document { #[serde(flatten)] pub note:Note, pub content:String, pub raw:String, pub yaml_error:Option<String> }
impl std::ops::Deref for Document { type Target=Note;fn deref(&self)->&Note {&self.note} }
#[derive(Serialize,Deserialize,Clone,Debug)]
pub struct TrashEntry { pub id:String, pub path:String, pub title:String, pub deleted:u64 }
#[derive(Serialize,Clone)]
pub struct HistoryEntry { pub id:String, pub created:u64, pub size:u64 }
pub struct Vault { pub root:PathBuf, db:Connection, _lock:File, cache:HashMap<String,(u128,u64,Note)>, snapshots:HashMap<String,u64> }

pub fn safe_path(root:&Path, relative:&str) -> Result<PathBuf> {
    let rel=Path::new(relative);
    if rel.is_absolute() || rel.components().any(|c|matches!(c,Component::ParentDir|Component::RootDir|Component::Prefix(_))) {return Err("Путь выходит за пределы хранилища".into());}
    let mut current=root.to_path_buf();
    for part in rel.components() { current.push(part.as_os_str()); if current.exists() || fs::symlink_metadata(&current).is_ok() { let resolved=fs::canonicalize(&current).map_err(err)?;if !resolved.starts_with(root){return Err("Символическая ссылка выходит за пределы хранилища".into());} } }
    Ok(root.join(rel))
}
fn parse(path:&str, raw:String, updated:u64) -> Document {
    let mut properties=json!({});let mut content=raw.clone();let mut yaml_error=None;
    if raw.starts_with("---\n") || raw.starts_with("---\r\n") {
        let normalized=raw.replace("\r\n","\n");
        if let Some(end)=normalized[4..].find("\n---") {
            let end=end+4;let after=end+4;
            if normalized.as_bytes().get(after).is_none_or(|b|*b==b'\n') {
                match serde_yaml::from_str::<serde_yaml::Value>(&normalized[4..end]) {
                    Ok(v)=>match serde_json::to_value(v) {Ok(v) if v.is_object()||v.is_null()=>{properties=if v.is_null(){json!({})}else{v};content=normalized[after..].trim_start_matches('\n').to_string();}, _=>yaml_error=Some("Frontmatter должен быть набором свойств".into())},
                    Err(e)=>yaml_error=Some(e.to_string()),
                }
            }else{yaml_error=Some("Некорректная граница YAML".into());}
        }else{yaml_error=Some("Нет закрывающего разделителя YAML".into());}
    }
    let title=properties["title"].as_str().filter(|s|!s.is_empty()).map(str::to_string).unwrap_or_else(||Path::new(path).file_stem().unwrap_or_default().to_string_lossy().to_string());
    let tags=match &properties["tags"] {Value::Array(a)=>a.iter().filter_map(Value::as_str).map(normalize_tag).filter(|s|!s.is_empty()).collect(),Value::String(s)=>s.split(',').map(normalize_tag).filter(|s|!s.is_empty()).collect(),_=>Vec::new()};
    let inline=Regex::new(r"(?:^|\s)#([\p{L}\p{N}_/-]+)").unwrap();
    let mut tags:Vec<String>=tags;for c in inline.captures_iter(&content){let t=normalize_tag(&c[1]);if !tags.contains(&t){tags.push(t);}}
    let mut links=Vec::new();let wiki=Regex::new(r"\[\[([^\]]+)\]\]").unwrap();for c in wiki.captures_iter(&content){links.push(c[1].to_string());}
    let md=Regex::new(r"(?:^|[^!])\[[^\]]*\]\(([^)]+)\)").unwrap();for c in md.captures_iter(&content){if !c[1].contains("://") {links.push(c[1].to_string());}}
    let sys=&properties["localnotes"];let id=sys["id"].as_str().filter(|s|!s.is_empty()).map(str::to_string).unwrap_or_else(||format!("file:{}",hash(path.as_bytes())));
    let note=Note{id,path:path.into(),title,tags,links,revision:hash(raw.as_bytes()),updated,excerpt:content.chars().take(400).collect(),favorite:sys["favorite"].as_bool().unwrap_or(false),parent_id:sys["parent_id"].as_str().map(str::to_string),properties};
    Document{note,content,raw,yaml_error}
}
fn normalize_tag(t:&str)->String {t.trim().trim_start_matches('#').to_lowercase()}
fn encode(content:&str, mut properties:Value) -> Result<String> {
    if !properties.is_object(){properties=json!({});}
    if !properties["localnotes"].is_object(){properties["localnotes"]=json!({});}
    if properties["localnotes"]["id"].as_str().is_none_or(|s|s.starts_with("file:")){properties["localnotes"]["id"]=json!(Uuid::new_v4().to_string());}
    let yaml=serde_yaml::to_string(&properties).map_err(err)?;
    Ok(format!("---\n{}---\n\n{}",yaml,content))
}
impl Vault {
    pub fn open(root:&Path,index:&Path)->Result<Self>{
        let root=fs::canonicalize(root).map_err(|_|"Папка недоступна. Подключите диск или выберите другую папку.".to_string())?;
        if !root.is_dir(){return Err("Выберите папку".into());}
        for name in [".localnotes",".localnotes/history",".localnotes/trash",".localnotes/views",".localnotes/conflicts"] {let path=safe_path(&root,name)?;fs::create_dir_all(path).map_err(err)?;}
        let lock_path=safe_path(&root,".localnotes/workspace.lock")?;
        let lock=OpenOptions::new().create(true).truncate(false).read(true).write(true).open(lock_path).map_err(err)?;
        lock.try_lock_exclusive().map_err(|_|"Это хранилище уже открыто другим экземпляром приложения".to_string())?;
        if let Some(parent)=index.parent(){fs::create_dir_all(parent).map_err(err)?;}
        let db=Connection::open(index).map_err(err)?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS notes(path TEXT PRIMARY KEY, title TEXT, body TEXT, tags TEXT, data TEXT); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(path UNINDEXED,title,body,tags,tokenize='unicode61');").map_err(err)?;
        Ok(Self{root,db,_lock:lock,cache:HashMap::new(),snapshots:HashMap::new()})
    }
    pub fn path(&self,path:&str)->Result<PathBuf>{safe_path(&self.root,path)}
    fn note_path(&self,path:&str)->Result<PathBuf>{
        if path.split('/').any(|p|p.starts_with('.')) || !path.to_lowercase().ends_with(".md"){return Err("Нужен Markdown-файл внутри хранилища".into());}
        self.path(path)
    }
    pub fn read(&self,path:&str)->Result<Document>{let p=self.note_path(path)?;let raw=fs::read_to_string(&p).map_err(err)?;let updated=p.metadata().map_err(err)?.modified().map_err(err)?.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();Ok(parse(path,raw,updated))}
    fn index(&self,doc:&Document)->Result<()> {
        self.db.execute("INSERT OR REPLACE INTO notes VALUES (?1,?2,?3,?4,?5)",params![doc.path,doc.title,doc.content,doc.tags.join(" "),serde_json::to_string(&doc.note).map_err(err)?]).map_err(err)?;
        self.db.execute("DELETE FROM search WHERE path=?1",[&doc.path]).map_err(err)?;
        self.db.execute("INSERT INTO search VALUES (?1,?2,?3,?4)",params![doc.path,doc.title,doc.content,doc.tags.join(" ")]).map_err(err)?;Ok(())
    }
    pub fn list(&mut self)->Result<Vec<Note>> {
        if !self.root.is_dir(){return Err("Хранилище недоступно. Проверьте подключение диска.".into());}
        let mut paths=HashSet::new();let mut notes=Vec::new();
        for entry in WalkDir::new(&self.root).follow_links(false).into_iter().filter_entry(|e|e.depth()==0||!e.file_name().to_string_lossy().starts_with('.')) {
            let Ok(entry)=entry else {continue};if !entry.file_type().is_file()||entry.path().extension().is_none_or(|e|e!="md"){continue;}
            let rel=entry.path().strip_prefix(&self.root).map_err(err)?.to_string_lossy().replace('\\',"/");
            let Ok(meta)=entry.metadata()else{continue};let stamp=meta.modified().map_err(err)?.duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();let len=meta.len();paths.insert(rel.clone());
            if let Some((old_stamp,old_len,n))=self.cache.get(&rel){if *old_stamp==stamp&&*old_len==len{notes.push(n.clone());continue;}}
            match self.read(&rel){Ok(doc)=>{self.index(&doc)?;notes.push(doc.note.clone());self.cache.insert(rel,(stamp,len,doc.note));},Err(_)=>continue}
        }
        let removed:Vec<String>=self.cache.keys().filter(|p|!paths.contains(*p)).cloned().collect();for p in removed{self.cache.remove(&p);self.db.execute("DELETE FROM notes WHERE path=?1",[&p]).map_err(err)?;self.db.execute("DELETE FROM search WHERE path=?1",[&p]).map_err(err)?;}
        notes.sort_by(|a,b|a.title.to_lowercase().cmp(&b.title.to_lowercase()));Ok(notes)
    }
    fn atomic(&self,path:&Path,bytes:&[u8])->Result<()> {
        if let Some(parent)=path.parent(){fs::create_dir_all(parent).map_err(err)?;}
        let temp=path.with_file_name(format!(".write-{}",Uuid::new_v4()));
        let result=(||{let mut f=OpenOptions::new().create_new(true).write(true).open(&temp).map_err(err)?;f.write_all(bytes).map_err(err)?;f.sync_all().map_err(err)?;fs::rename(&temp,path).map_err(err)?;if let Some(parent)=path.parent(){if let Ok(d)=File::open(parent){let _=d.sync_all();}}Ok(())})();
        if result.is_err(){let _=fs::remove_file(temp);}result
    }
    fn snapshot(&mut self,path:&str,raw:&str,force:bool)->Result<()> {
        if raw.is_empty(){return Ok(());}if !force&&self.snapshots.get(path).is_some_and(|last|now().saturating_sub(*last)<60){return Ok(());}
        let folder=format!(".localnotes/history/{}",hash(path.as_bytes()));let dir=self.path(&folder)?;fs::create_dir_all(&dir).map_err(err)?;
        let entries=self.history(path)?;
        if let Some(latest)=entries.first(){if fs::read(dir.join(&latest.id)).ok().as_deref()==Some(raw.as_bytes()){return Ok(());}}
        let id=format!("{}-{}.md",now(),Uuid::new_v4());self.atomic(&dir.join(id),raw.as_bytes())?;self.snapshots.insert(path.into(),now());Ok(())
    }
    pub fn save(&mut self,path:&str,expected:&str,content:&str,patch:Option<Value>)->Result<Document>{
        let old=self.read(path)?;
        if old.revision!=expected{let conflict=self.path(&format!(".localnotes/conflicts/{}.md",Uuid::new_v4()))?;self.atomic(&conflict,content.as_bytes())?;return Err("CONFLICT: Файл изменён другой программой. Ваша версия сохранена отдельно.".into());}
        if old.yaml_error.is_some(){return Err("Некорректный YAML. Исправьте полный исходник перед визуальным редактированием.".into());}
        let mut props=old.properties.clone();if let Some(patch)=patch{if let Some(map)=patch.as_object(){for(k,v)in map{if k=="localnotes"{if let Some(obj)=v.as_object(){if !props[k].is_object(){props[k]=json!({});}for(sk,sv)in obj{if sk!="id"{props[k][sk]=sv.clone();}}}}else{props[k]=v.clone();}}}}
        let raw=encode(content,props)?;self.snapshot(path,&old.raw,false)?;
        let p=self.note_path(path)?;
        if hash(&fs::read(&p).map_err(err)?)!=expected {return Err("CONFLICT: Файл меняется во время сохранения. Черновик остаётся в редакторе.".into());}
        self.atomic(&p,raw.as_bytes())?;let doc=self.read(path)?;self.index(&doc)?;self.cache.remove(path);Ok(doc)
    }
    pub fn save_raw(&mut self,path:&str,expected:&str,raw:&str)->Result<Document>{let old=self.read(path)?;if old.revision!=expected{return Err("CONFLICT: Файл изменён другой программой".into());}self.snapshot(path,&old.raw,true)?;self.atomic(&self.note_path(path)?,raw.as_bytes())?;let doc=self.read(path)?;self.index(&doc)?;self.cache.remove(path);Ok(doc)}
    pub fn create(&mut self,title:&str,parent:Option<String>)->Result<Document>{
        let title=if title.trim().is_empty(){"Без названия"}else{title.trim()};let name:String=title.chars().map(|c|if c=='/'||c=='\\'||c==':'||c.is_control(){'_'}else{c}).take(100).collect();let name=name.trim_matches('.');let name=if name.is_empty(){"Страница"}else{name};
        let mut path=format!("{}.md",name);let existing:HashSet<String>=self.list()?.iter().map(|n|n.path.to_lowercase()).collect();if existing.contains(&path.to_lowercase()){path=format!("{}-{}.md",name,&Uuid::new_v4().to_string()[..8]);}
        let raw=encode("",json!({"title":title,"tags":[],"status":"Без статуса","localnotes":{"id":Uuid::new_v4().to_string(),"parent_id":parent}}))?;let p=self.note_path(&path)?;
        let mut f=OpenOptions::new().create_new(true).write(true).open(p).map_err(err)?;f.write_all(raw.as_bytes()).map_err(err)?;f.sync_all().map_err(err)?;let doc=self.read(&path)?;self.index(&doc)?;Ok(doc)
    }
    pub fn trash(&mut self,path:&str)->Result<String>{
        let doc=self.read(path)?;let id=Uuid::new_v4().to_string();let target=self.path(&format!(".localnotes/trash/{}.md",id))?;let item=TrashEntry{id:id.clone(),path:path.into(),title:doc.title.clone(),deleted:now()};let meta=self.path(&format!(".localnotes/trash/{}.json",id))?;self.atomic(&meta,&serde_json::to_vec(&item).map_err(err)?)?;
        fs::rename(self.note_path(path)?,target).map_err(err)?;self.cache.remove(path);self.db.execute("DELETE FROM notes WHERE path=?1",[path]).map_err(err)?;self.db.execute("DELETE FROM search WHERE path=?1",[path]).map_err(err)?;Ok(id)
    }
    fn uuid(id:&str)->Result<()> {Uuid::parse_str(id).map(|_|()).map_err(err)}
    pub fn trash_list(&self)->Result<Vec<TrashEntry>>{let mut out=Vec::new();for e in fs::read_dir(self.path(".localnotes/trash")?).map_err(err)?{let e=e.map_err(err)?;if e.path().extension().is_some_and(|x|x=="json"){if let Ok(item)=serde_json::from_slice::<TrashEntry>(&fs::read(e.path()).map_err(err)?){if self.path(&format!(".localnotes/trash/{}.md",item.id))?.exists(){out.push(item);}}}}out.sort_by_key(|x|std::cmp::Reverse(x.deleted));Ok(out)}
    pub fn restore(&mut self,id:&str)->Result<Document>{Self::uuid(id)?;let item:TrashEntry=serde_json::from_slice(&fs::read(self.path(&format!(".localnotes/trash/{}.json",id))?).map_err(err)?).map_err(err)?;let dest=self.note_path(&item.path)?;if dest.exists(){return Err("Путь занят другой заметкой. Переместите её перед восстановлением.".into());}
        if let Some(p)=dest.parent(){fs::create_dir_all(p).map_err(err)?;}fs::hard_link(self.path(&format!(".localnotes/trash/{}.md",id))?,&dest).map_err(err)?;fs::remove_file(self.path(&format!(".localnotes/trash/{}.md",id))?).map_err(err)?;fs::remove_file(self.path(&format!(".localnotes/trash/{}.json",id))?).map_err(err)?;let doc=self.read(&item.path)?;self.index(&doc)?;Ok(doc)}
    pub fn history(&self,path:&str)->Result<Vec<HistoryEntry>>{self.note_path(path)?;let dir=self.path(&format!(".localnotes/history/{}",hash(path.as_bytes())))?;if !dir.exists(){return Ok(Vec::new());}let mut entries=Vec::new();for e in fs::read_dir(dir).map_err(err)?{let e=e.map_err(err)?;let id=e.file_name().to_string_lossy().to_string();if !id.ends_with(".md"){continue;}let created=id.split('-').next().and_then(|s|s.parse().ok()).unwrap_or(0);entries.push(HistoryEntry{id,created,size:e.metadata().map_err(err)?.len()});}entries.sort_by(|a,b|b.created.cmp(&a.created).then_with(||b.id.cmp(&a.id)));Ok(entries)}
    pub fn restore_history(&mut self,path:&str,id:&str,expected:&str)->Result<Document>{if id.contains('/')||id.contains('\\')||!self.history(path)?.iter().any(|h|h.id==id){return Err("Версия не найдена".into());}let old=self.read(path)?;if old.revision!=expected{return Err("CONFLICT: Сначала обновите страницу".into());}let raw=fs::read_to_string(self.path(&format!(".localnotes/history/{}/{}",hash(path.as_bytes()),id))?).map_err(err)?;self.snapshot(path,&old.raw,true)?;self.save_raw(path,expected,&raw)}
    pub fn attach(&self,source:&Path)->Result<String>{
        let original=source.file_name().ok_or("Не задано имя файла")?.to_string_lossy();let clean:String=original.chars().map(|c|if c=='/'||c=='\\'||c.is_control(){'_'}else{c}).collect();let rel=format!("Вложения/{}-{}",&Uuid::new_v4().to_string()[..8],clean);let dest=self.path(&rel)?;let parent=dest.parent().unwrap();fs::create_dir_all(parent).map_err(err)?;let temp=parent.join(format!(".upload-{}",Uuid::new_v4()));
        let result=(||{let mut src=File::open(source).map_err(err)?;if !src.metadata().map_err(err)?.is_file(){return Err("Нужен обычный файл".into());}let mut out=OpenOptions::new().create_new(true).write(true).open(&temp).map_err(err)?;std::io::copy(&mut src,&mut out).map_err(err)?;out.sync_all().map_err(err)?;fs::rename(&temp,&dest).map_err(err)?;Ok(rel)})();if result.is_err(){let _=fs::remove_file(temp);}result
    }
    pub fn search(&mut self,query:&str)->Result<Vec<Note>>{self.list()?;let query=query.split_whitespace().filter_map(|w|{let word:String=w.chars().filter(|c|c.is_alphanumeric()).collect();if word.is_empty(){None}else{Some(format!("\"{}\"*",word))}}).collect::<Vec<_>>().join(" AND ");if query.is_empty(){return self.list();}
        let mut stmt=self.db.prepare("SELECT notes.data FROM search JOIN notes ON notes.path=search.path WHERE search MATCH ?1 ORDER BY bm25(search,0,5,1,1) LIMIT 200").map_err(err)?;let rows=stmt.query_map([query],|r|r.get::<_,String>(0)).map_err(err)?;let mut out=Vec::new();for row in rows{out.push(serde_json::from_str(&row.map_err(err)?).map_err(err)?);}Ok(out)}
    pub fn rebuild(&mut self)->Result<()> {self.db.execute_batch("DELETE FROM notes;DELETE FROM search;").map_err(err)?;self.cache.clear();self.list()?;Ok(())}
    pub fn load_views(&self)->Result<Value>{let p=self.path(".localnotes/views/workspace.yaml")?;if !p.exists(){return Ok(json!([]));}let text=fs::read_to_string(p).map_err(err)?;serde_yaml::from_str(&text).map_err(err)}
    pub fn save_views(&self,views:&Value)->Result<()> {if !views.is_array(){return Err("Нужен список представлений".into());}self.atomic(&self.path(".localnotes/views/workspace.yaml")?,serde_yaml::to_string(views).map_err(err)?.as_bytes())}
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    fn vault() -> (TempDir, Vault) { let dir=TempDir::new().unwrap(); let v=Vault::open(dir.path(), &dir.path().join("index.sqlite")).unwrap(); (dir,v) }
    #[test] fn save_detects_external_change_and_preserves_both() {
        let (dir, mut v)=vault(); let n=v.create("Идея",None).unwrap();
        let disk=dir.path().join(&n.path); std::fs::write(&disk,"external change").unwrap();
        assert!(v.save(&n.path,&n.revision,"my draft",None).unwrap_err().starts_with("CONFLICT:"));
        assert_eq!(std::fs::read_to_string(disk).unwrap(),"external change");
    }
    #[test] fn markdown_reopens_and_properties_are_preserved() {
        let (dir,mut v)=vault(); std::fs::write(dir.path().join("old.md"),"---\ncustom:\n  keep: 42\ntags: [project]\n---\nOriginal").unwrap();
        let n=v.read("old.md").unwrap();let n=v.save("old.md",&n.revision,"Updated",Some(serde_json::json!({"status":"Ready"}))).unwrap();
        assert_eq!(n.content,"Updated");assert_eq!(n.properties["custom"]["keep"],42);assert_eq!(v.read("old.md").unwrap().tags,vec!["project"]);
    }
    #[test] fn traversal_and_escaping_symlinks_are_rejected() {
        let (dir,v)=vault();assert!(v.read("../outside.md").is_err());
        let outside=TempDir::new().unwrap();std::fs::write(outside.path().join("secret.md"),"secret").unwrap();
        #[cfg(unix)] { std::os::unix::fs::symlink(outside.path(),dir.path().join("escape")).unwrap();assert!(v.read("escape/secret.md").is_err()); }
    }
    #[test] fn trash_restore_collision_never_overwrites() {
        let (dir,mut v)=vault();let n=v.create("Страница",None).unwrap();let item=v.trash(&n.path).unwrap();
        std::fs::write(dir.path().join(&n.path),"replacement").unwrap();assert!(v.restore(&item).is_err());assert_eq!(std::fs::read_to_string(dir.path().join(&n.path)).unwrap(),"replacement");
    }
    #[test] fn malformed_yaml_is_readable_but_cannot_be_silently_rewritten() {
        let (dir,mut v)=vault();std::fs::write(dir.path().join("bad.md"),"---\ntags: [\n---\nkeep text").unwrap();let n=v.read("bad.md").unwrap();assert!(n.yaml_error.is_some());assert!(v.save("bad.md",&n.revision,"new",None).is_err());
    }
    #[test] fn attachment_is_copied_and_index_can_be_rebuilt() {
        let (dir,mut v)=vault();let source=TempDir::new().unwrap();std::fs::write(source.path().join("asset.bin"),vec![17u8;1048577]).unwrap();let path=v.attach(&source.path().join("asset.bin")).unwrap();assert_eq!(std::fs::metadata(dir.path().join(path)).unwrap().len(),1048577);
        let n=v.create("Тест поиска",None).unwrap();v.save(&n.path,&n.revision,"Светильник prototype",None).unwrap();assert_eq!(v.search("свет").unwrap().len(),1);assert_eq!(v.search("prot").unwrap().len(),1);v.rebuild().unwrap();assert_eq!(v.list().unwrap().len(),1);
    }
}
