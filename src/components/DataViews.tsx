import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Table2,
  LayoutGrid,
  Columns3,
  Network,
  Tag,
  Plus,
  ArrowDownWideNarrow,
  FileText,
  Check,
  X,
} from "lucide-react";
import { selectNotes, type DataView, type Note } from "../core/model";
const GraphView = lazy(() => import("./GraphView"));
interface Props {
  notes: Note[];
  view: DataView;
  onView: (view: DataView) => void;
  onOpen: (n: Note) => void;
  onPatch: (n: Note, patch: Record<string, unknown>) => void;
  onCreate: () => void;
  pageMode?: boolean;
}
const layouts = [
  ["table", "Таблица", Table2],
  ["cards", "Карточки", LayoutGrid],
  ["board", "Канбан", Columns3],
  ["graph", "Связи", Network],
] as const;
function VirtualTable({
  notes,
  onOpen,
  onPatch,
}: {
  notes: Note[];
  onOpen: Props["onOpen"];
  onPatch: Props["onPatch"];
}) {
  const parent = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({
    count: notes.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 49,
    overscan: 8,
  });
  return (
    <div className="table-frame">
      <div className="database-row table-header">
        <span>Название</span>
        <span>Теги</span>
        <span>Статус</span>
        <span>Изменено</span>
      </div>
      <div ref={parent} className="table-scroll">
        <div style={{ height: rows.getTotalSize(), position: "relative" }}>
          {rows.getVirtualItems().map((row) => {
            const n = notes[row.index];
            return (
              <div
                className="database-row"
                key={n.id}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <button className="table-title" onClick={() => onOpen(n)}>
                  <FileText size={16} />
                  <span>{n.title}</span>
                </button>
                <input
                  aria-label={"Теги: " + n.title}
                  defaultValue={n.tags.join(", ")}
                  key={n.path + n.tags.join(",")}
                  onBlur={(e) => {
                    if (e.target.value !== n.tags.join(", "))
                      onPatch(n, {
                        tags: e.target.value
                          .split(",")
                          .map((t) => t.trim().replace(/^#/, ""))
                          .filter(Boolean),
                      });
                  }}
                  placeholder="Добавить…"
                />
                <input
                  aria-label={"Статус: " + n.title}
                  defaultValue={String(n.properties.status ?? "")}
                  key={n.path + String(n.properties.status)}
                  onBlur={(e) => {
                    if (e.target.value !== String(n.properties.status ?? ""))
                      onPatch(n, { status: e.target.value });
                  }}
                  placeholder="Без статуса"
                />
                <span className="date">
                  {new Date(n.updated * 1000).toLocaleDateString("ru", {
                    day: "numeric",
                    month: "short",
                  })}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
export function DataViews({
  notes,
  view,
  onView,
  onOpen,
  onPatch,
  onCreate,
  pageMode = false,
}: Props) {
  const [filters, setFilters] = useState(false),
    [search, setSearch] = useState("");
  const allTags = useMemo(
    () =>
      [...new Set(notes.flatMap((n) => n.tags))].sort((a, b) =>
        a.localeCompare(b, "ru"),
      ),
    [notes],
  );
  const selected = useMemo(
    () =>
      selectNotes(notes, view).filter((n) =>
        n.title.toLowerCase().includes(search.toLowerCase()),
      ),
    [notes, view, search],
  );
  const groups = useMemo(() => {
    const map = new Map<string, Note[]>();
    for (const status of ["Без статуса", "В работе", "Готово"])
      map.set(status, []);
    for (const n of selected) {
      const key =
        String(n.properties[view.groupBy] ?? "Без статуса") || "Без статуса";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(n);
    }
    return [...map];
  }, [selected, view.groupBy]);
  return (
    <section className="database">
      <div className="database-heading">
        <div>
          <div className="row">
            <Network size={27} className="view-icon" />
            <input
              aria-label={pageMode ? "Название страницы" : "Название Data View"}
              className="view-title"
              key={view.id}
              defaultValue={view.name}
              onBlur={(e) => {
                if (e.target.value.trim())
                  onView({ ...view, name: e.target.value.trim() });
              }}
            />
          </div>
          <p>
            {pageMode
              ? "Вложенные страницы. Текст и вложения доступны во вкладке «Текст»."
              : "Страницы одного проекта. Все виды используют общий набор тегов."}
          </p>
        </div>
        <button className="primary-button" onClick={onCreate}>
          <Plus size={16} />
          Новая страница
        </button>
      </div>
      <div className="view-toolbar">
        {!pageMode ? (
          <div className="layout-tabs" role="tablist">
            {layouts.map(([id, label, Icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view.layout === id}
                className={view.layout === id ? "selected" : ""}
                onClick={() => onView({ ...view, layout: id })}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        ) : (
          <span className="muted page-view-label">Вложенные страницы</span>
        )}
        <div className="row">
          <button
            className={"quiet-button " + (filters ? "selected" : "")}
            onClick={() => setFilters((s) => !s)}
          >
            <Tag size={15} />
            Теги{view.tags.length ? " · " + view.tags.length : ""}
          </button>
          <button
            className="icon-button"
            aria-label="Сменить сортировку"
            title={view.sort === "updated" ? "Сначала новые" : "По названию"}
            onClick={() =>
              onView({
                ...view,
                sort: view.sort === "updated" ? "title" : "updated",
              })
            }
          >
            <ArrowDownWideNarrow size={17} />
          </button>
        </div>
      </div>
      {filters ? (
        <div className="tag-filter">
          <div className="row">
            <span>Включить страницы с тегами</span>
            <select
              aria-label="Правило тегов"
              value={view.match}
              onChange={(e) =>
                onView({ ...view, match: e.target.value as DataView["match"] })
              }
            >
              <option value="any">Любой из выбранных</option>
              <option value="all">Все выбранные</option>
            </select>
            <button
              className="quiet-button"
              onClick={() => onView({ ...view, tags: [] })}
            >
              Сбросить
            </button>
          </div>
          <div className="tag-options">
            {allTags.length ? (
              allTags.map((tag) => (
                <button
                  key={tag}
                  className={
                    "tag-chip " + (view.tags.includes(tag) ? "selected" : "")
                  }
                  onClick={() =>
                    onView({
                      ...view,
                      tags: view.tags.includes(tag)
                        ? view.tags.filter((t) => t !== tag)
                        : [...view.tags, tag],
                    })
                  }
                >
                  {view.tags.includes(tag) ? (
                    <Check size={12} />
                  ) : (
                    <Tag size={12} />
                  )}{" "}
                  {tag}
                </button>
              ))
            ) : (
              <span>Добавьте теги в свойствах страницы.</span>
            )}
          </div>
        </div>
      ) : null}
      <div className="view-summary">
        <div className="row">
          {view.tags.length ? (
            view.tags.map((tag) => (
              <button
                className="tag-chip"
                key={tag}
                onClick={() =>
                  onView({ ...view, tags: view.tags.filter((t) => t !== tag) })
                }
              >
                <Tag size={11} />
                {tag}
                <X size={11} />
              </button>
            ))
          ) : (
            <span>{pageMode ? "Вложенные страницы" : "Все страницы"}</span>
          )}
          <span className="muted">
            {selected.length} {selected.length === 1 ? "страница" : "страниц"}
          </span>
        </div>
        {view.layout !== "graph" ? (
          <input
            aria-label="Поиск в представлении"
            placeholder="Найти страницу…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        ) : null}
      </div>
      {selected.length === 0 ? (
        <div className="empty-state">
          <Tag size={30} />
          <h2>Здесь пока нет страниц</h2>
          <p>
            {pageMode
              ? view.tags.length
                ? "Измените фильтр или создайте вложенную страницу."
                : "Создайте вложенную страницу — она появится во всех представлениях."
              : "Добавьте выбранный тег к странице или измените фильтр."}
          </p>
          <button
            className="quiet-button"
            onClick={() =>
              pageMode && !view.tags.length
                ? onCreate()
                : onView({ ...view, tags: [] })
            }
          >
            {pageMode
              ? view.tags.length
                ? "Сбросить фильтр"
                : "Создать вложенную страницу"
              : "Показать все страницы"}
          </button>
        </div>
      ) : view.layout === "table" ? (
        <VirtualTable notes={selected} onOpen={onOpen} onPatch={onPatch} />
      ) : view.layout === "cards" ? (
        <div className="cards-grid">
          {selected.map((n) => (
            <button className="note-card" key={n.id} onClick={() => onOpen(n)}>
              <FileText size={23} />
              <h3>{n.title}</h3>
              <p>{n.excerpt.replace(/[#*\[\]]/g, "").slice(0, 150)}</p>
              <div className="row">
                {n.tags.slice(0, 3).map((t) => (
                  <span className="tag-chip" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      ) : view.layout === "board" ? (
        <div className="board">
          {groups.map(([status, items]) => (
            <section
              className="board-column"
              key={status}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const n = notes.find(
                  (n) => n.path === e.dataTransfer.getData("text/plain"),
                );
                if (n) onPatch(n, { [view.groupBy]: status });
              }}
            >
              <header>
                <span
                  className={
                    "status-dot " +
                    (status === "Готово"
                      ? "done"
                      : status === "В работе"
                        ? "working"
                        : "")
                  }
                />
                {status}
                <span className="muted">{items.length}</span>
              </header>
              {items.map((n) => (
                <button
                  className="board-card"
                  key={n.id}
                  draggable
                  onDragStart={(e) =>
                    e.dataTransfer.setData("text/plain", n.path)
                  }
                  onClick={() => onOpen(n)}
                >
                  {n.title}
                  <div className="row">
                    {n.tags.map((t) => (
                      <span key={t} className="tag-chip">
                        {t}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <Suspense fallback={<div className="empty-state">Загрузка графа…</div>}>
          <GraphView
            notes={selected}
            allNotes={notes}
            onOpen={onOpen}
            onTag={(tag) =>
              onView({
                ...view,
                tags: [...new Set([...view.tags, tag])],
                match: "all",
              })
            }
          />
        </Suspense>
      )}
    </section>
  );
}
