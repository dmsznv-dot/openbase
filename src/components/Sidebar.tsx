import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Search,
  Plus,
  Settings,
  Trash2,
  Network,
  FileText,
  FolderOpen,
  ChevronDown,
  Star,
} from "lucide-react";
import type { Note, DataView } from "../core/model";
export function Sidebar({
  root,
  notes,
  views,
  current,
  screen,
  activeView,
  onOpen,
  onScreen,
  onView,
  onCreate,
  onNewView,
  onOpenVault,
  onSearch,
}: {
  root: string;
  notes: Note[];
  views: DataView[];
  current: string | undefined;
  screen: string;
  activeView: string;
  onOpen: (n: Note) => void;
  onScreen: (s: string) => void;
  onView: (v: DataView) => void;
  onCreate: () => void;
  onNewView: () => void;
  onOpenVault: () => void;
  onSearch: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const flat = useMemo(() => {
    const byParent = new Map<string, Note[]>();
    const ids = new Set(notes.map((n) => n.id));
    for (const n of notes) {
      const key = n.parent_id && ids.has(n.parent_id) ? n.parent_id : "";
      const a = byParent.get(key) ?? [];
      a.push(n);
      byParent.set(key, a);
    }
    const result: { note: Note; depth: number }[] = [];
    const seen = new Set<string>();
    const walk = (parent: string, depth: number) => {
      for (const n of byParent.get(parent) ?? []) {
        if (seen.has(n.path)) continue;
        seen.add(n.path);
        result.push({ note: n, depth: Math.min(depth, 8) });
        walk(n.id, depth + 1);
      }
    };
    walk("", 0);
    for (const n of notes)
      if (!seen.has(n.path)) result.push({ note: n, depth: 0 });
    return result;
  }, [notes]);
  const virtual = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 33,
    overscan: 8,
  });
  return (
    <aside className="sidebar">
      <div className="window-drag" data-tauri-drag-region />
      <button
        className="workspace-button"
        onClick={onOpenVault}
        title="Открыть другую папку"
      >
        <span className="workspace-symbol">
          <Network size={19} />
        </span>
        <div>
          <strong>Local Notes</strong>
          <small>
            {root ? root.split("/").pop() : "Локальное пространство"}
          </small>
        </div>
        <ChevronDown size={14} />
      </button>
      <div className="sidebar-actions">
        <button
          onClick={onSearch}
          aria-label="Поиск"
          aria-keyshortcuts="Meta+K"
        >
          <Search size={17} />
          <span>Поиск</span>
          <kbd aria-hidden="true">⌘ K</kbd>
        </button>
        <button onClick={onCreate} disabled={!root}>
          <Plus size={17} />
          <span>Новая страница</span>
        </button>
      </div>
      {notes.some((n) => n.favorite) ? (
        <div className="sidebar-section favorites">
          <header>Избранное</header>
          {notes
            .filter((n) => n.favorite)
            .slice(0, 8)
            .map((n) => (
              <button
                key={n.path}
                className={
                  screen === "page" && current === n.path ? "active" : ""
                }
                onClick={() => onOpen(n)}
              >
                <Star size={14} />
                <span>{n.title}</span>
              </button>
            ))}
        </div>
      ) : null}
      <div className="sidebar-section">
        <header>
          <span>Data Views</span>
          <button
            className="icon-button"
            title="Создать Data View"
            aria-label="Создать Data View"
            onClick={onNewView}
            disabled={!root}
          >
            <Plus size={14} />
          </button>
        </header>
        {views.map((v) => (
          <button
            key={v.id}
            className={screen === "data" && activeView === v.id ? "active" : ""}
            onClick={() => onView(v)}
          >
            <Network size={16} />
            <span>{v.name}</span>
            {v.tags.length ? <small>{v.tags.length}</small> : null}
          </button>
        ))}
      </div>
      <div className="sidebar-section pages-section">
        <header>
          <span>
            Страницы <small>{notes.length || ""}</small>
          </span>
          <button
            className="icon-button"
            title="Новая страница"
            aria-label="Новая страница"
            onClick={onCreate}
            disabled={!root}
          >
            <Plus size={14} />
          </button>
        </header>
        <div className="page-tree" ref={scroll}>
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => {
              const { note: n, depth } = flat[item.index];
              return (
                <button
                  key={n.path}
                  className={
                    screen === "page" && current === n.path ? "active" : ""
                  }
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: 33,
                    transform: `translateY(${item.start}px)`,
                    paddingLeft: 12 + depth * 13,
                  }}
                  onClick={() => onOpen(n)}
                >
                  <FileText size={15} />
                  <span>{n.title}</span>
                </button>
              );
            })}
          </div>
          {!notes.length ? (
            <p className="sidebar-empty">Создайте первую страницу</p>
          ) : null}
        </div>
      </div>
      <footer className="sidebar-bottom">
        <button
          className={screen === "settings" ? "active" : ""}
          onClick={() => onScreen("settings")}
        >
          <Settings size={16} />
          Настройки
        </button>
        <button
          className={screen === "trash" ? "active" : ""}
          disabled={!root}
          onClick={() => onScreen("trash")}
        >
          <Trash2 size={16} />
          Корзина
        </button>
        <div className="local-indicator">
          <span />
          Хранится на вашем Mac
          <FolderOpen size={13} />
        </div>
      </footer>
    </aside>
  );
}
