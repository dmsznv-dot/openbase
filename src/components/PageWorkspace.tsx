import type { ReactNode } from "react";
import { FileText, Table2, LayoutGrid, Columns3 } from "lucide-react";
import { DataViews } from "./DataViews";
import {
  getPageView,
  pageChildren,
  pageViewPatch,
  type Note,
  type PageView,
} from "../core/model";

const layouts = [
  ["text", "Текст", FileText],
  ["table", "Таблица", Table2],
  ["board", "Канбан", Columns3],
  ["cards", "Карточки", LayoutGrid],
] as const;

export function PageWorkspace({
  note,
  notes,
  children,
  onPatch,
  onOpen,
  onCreate,
  onPatchNote,
  onSwitch,
}: {
  note: Note;
  notes: Note[];
  children: ReactNode;
  onPatch: (patch: Record<string, unknown>) => void;
  onOpen: (note: Note) => void;
  onCreate: (parent: string, tags: string[]) => void;
  onPatchNote: (note: Note, patch: Record<string, unknown>) => void;
  onSwitch: (view: PageView) => void;
}) {
  const view = getPageView(note);
  return (
    <section className="page-workspace">
      <nav
        className="page-layouts layout-tabs"
        role="tablist"
        aria-label="Представление страницы"
      >
        {layouts.map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={view.layout === id}
            className={view.layout === id ? "selected" : ""}
            onClick={() => onSwitch({ ...view, layout: id })}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </nav>
      {view.layout === "text" ? (
        children
      ) : (
        <DataViews
          notes={pageChildren(notes, note.id)}
          view={{ ...view, id: note.id, name: note.title, layout: view.layout }}
          pageMode
          onView={(next) => {
            const { id: _id, name, layout, ...settings } = next;
            onPatch({
              ...pageViewPatch(note, {
                ...settings,
                layout: layout as PageView["layout"],
              }),
              ...(name !== note.title ? { title: name } : {}),
            });
          }}
          onOpen={onOpen}
          onPatch={onPatchNote}
          onCreate={() => onCreate(note.id, view.tags)}
        />
      )}
    </section>
  );
}
