export interface Note {
  identity_conflict?: boolean;
  id: string;
  path: string;
  title: string;
  tags: string[];
  properties: Record<string, unknown>;
  links: string[];
  revision: string;
  updated: number;
  excerpt: string;
  favorite: boolean;
  parent_id: string | null;
}
export interface Document extends Note {
  content: string;
  raw: string;
  yaml_error: string | null;
}
export interface DataView {
  id: string;
  name: string;
  tags: string[];
  match: "any" | "all";
  layout: "table" | "cards" | "board" | "graph";
  sort: "title" | "updated";
  groupBy: string;
}
export interface PageView extends Omit<DataView, "id" | "name" | "layout"> {
  layout: "text" | "table" | "cards" | "board";
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function getPageView(note: Note): PageView {
  const saved = record(record(note.properties.localnotes).page_view);
  return {
    layout: ["table", "cards", "board"].includes(String(saved.layout))
      ? (saved.layout as PageView["layout"])
      : "text",
    tags: Array.isArray(saved.tags)
      ? saved.tags.filter((t): t is string => typeof t === "string")
      : [],
    match: saved.match === "all" ? "all" : "any",
    sort: saved.sort === "updated" ? "updated" : "title",
    groupBy: "status",
  };
}
export function pageViewPatch(
  note: Note,
  view: PageView,
): Record<string, unknown> {
  return {
    localnotes: { ...record(note.properties.localnotes), page_view: view },
  };
}
export function pageChildren(notes: Note[], parentId: string): Note[] {
  return notes.filter((n) => n.parent_id === parentId && n.id !== parentId);
}
export interface GraphNode {
  id: string;
  label: string;
  kind: "page" | "tag";
  note?: Note;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "link" | "tag";
}
export const normalizeTag = (tag: string) =>
  tag.trim().replace(/^#+/, "").toLocaleLowerCase("ru");
export function selectNotes(notes: Note[], view: DataView): Note[] {
  const tags = view.tags.map(normalizeTag).filter(Boolean);
  return notes
    .filter((n) => {
      const own = n.tags.map(normalizeTag);
      return (
        !tags.length ||
        (view.match === "all"
          ? tags.every((t) => own.includes(t))
          : tags.some((t) => own.includes(t)))
      );
    })
    .sort((a, b) =>
      view.sort === "updated"
        ? b.updated - a.updated
        : a.title.localeCompare(b.title, "ru"),
    );
}
export function resolveLink(
  notes: Note[],
  source: Note,
  target: string,
): Note | undefined {
  let clean: string;
  try {
    clean = decodeURIComponent(target.split("|")[0].split("#")[0])
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "");
  } catch {
    return undefined;
  }
  if (!clean || /^[a-z]+:/i.test(clean)) return;
  const normalize = (p: string) => {
    const out: string[] = [];
    for (const part of p.split("/")) {
      if (part === "..") out.pop();
      else if (part && part !== ".") out.push(part);
    }
    return out.join("/").replace(/\.md$/i, "").toLocaleLowerCase("ru");
  };
  const folder = source.path.includes("/")
    ? source.path.slice(0, source.path.lastIndexOf("/") + 1)
    : "";
  if (target.includes("/") || /\.md(?:#|$)/i.test(target)) {
    const relative = notes.filter(
      (n) => normalize(n.path) === normalize(folder + clean),
    );
    if (relative.length === 1) return relative[0];
    if (relative.length > 1) return;
    const absolute = notes.filter(
      (n) => normalize(n.path) === normalize(clean),
    );
    if (absolute.length === 1) return absolute[0];
    return;
  }
  const byName = notes.filter(
    (n) =>
      n.title.toLocaleLowerCase("ru") === clean.toLocaleLowerCase("ru") ||
      n.path.split("/").pop()?.replace(/\.md$/i, "").toLocaleLowerCase("ru") ===
        clean.toLocaleLowerCase("ru"),
  );
  if (byName.length === 1) return byName[0];
}
export function buildGraph(
  notes: Note[],
  showTags = true,
  allNotes: Note[] = notes,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const included = new Set(notes.map((n) => n.path));
  const nodes: GraphNode[] = notes.map((n) => ({
    id: n.id,
    label: n.title,
    kind: "page",
    note: n,
  }));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const n of notes) {
    for (const target of n.links) {
      const to = resolveLink(allNotes, n, target);
      if (to && included.has(to.path) && to.id !== n.id) {
        const id = `link:${n.id}:${to.id}`;
        if (!seen.has(id)) {
          edges.push({ id, source: n.id, target: to.id, kind: "link" });
          seen.add(id);
        }
      }
    }
    if (showTags)
      for (const tag of new Set(n.tags.map(normalizeTag).filter(Boolean))) {
        const id = `tag:${tag}`;
        if (!seen.has(id)) {
          nodes.push({ id, label: "#" + tag, kind: "tag" });
          seen.add(id);
        }
        edges.push({
          id: `member:${n.id}:${tag}`,
          source: n.id,
          target: id,
          kind: "tag",
        });
      }
  }
  return { nodes, edges };
}
export function searchNotes(notes: Note[], query: string): Note[] {
  const words = query
    .trim()
    .toLocaleLowerCase("ru")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return notes;
  const score = (n: Note) => {
    const title = n.title.toLocaleLowerCase("ru");
    const all = [title, n.excerpt, ...n.tags, JSON.stringify(n.properties)]
      .join(" ")
      .toLocaleLowerCase("ru");
    return words.every((w) => all.includes(w))
      ? words.reduce(
          (s, w) => s + (title.startsWith(w) ? 10 : title.includes(w) ? 5 : 1),
          0,
        )
      : 0;
  };
  return notes
    .map((n) => ({ n, s: score(n) }))
    .filter((x) => x.s)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.n);
}

export function attachmentPath(notePath: string, target: string): string {
  const decoded = decodeURIComponent(target.split("#")[0]);
  if (/^[a-z]+:/i.test(decoded) || decoded.startsWith("/"))
    throw Error("Нужна локальная относительная ссылка");
  const parts = notePath.split("/").slice(0, -1);
  for (const p of decoded.split("/")) {
    if (p === "..") {
      if (!parts.length) throw Error("Путь выходит за пределы хранилища");
      parts.pop();
    } else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
}
