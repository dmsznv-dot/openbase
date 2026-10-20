import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, Star, Trash2 } from "lucide-react";
import type { Note } from "../core/model";

export function PageMenu({
  note,
  anchor,
  onClose,
  onRename,
  onFavorite,
  onRemove,
}: {
  note: Note;
  anchor: HTMLElement;
  onClose: () => void;
  onRename: (note: Note, title: string) => void;
  onFavorite: (note: Note) => void;
  onRemove: (note: Note) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(note.title);
  const menu = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  useEffect(() => {
    menu.current
      ?.querySelector<HTMLElement>(renaming ? "input" : "button")
      ?.focus();
  }, [renaming]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (
        !menu.current?.contains(e.target as Node) &&
        !anchor.contains(e.target as Node)
      )
        onClose();
    };
    const reposition = () => onClose();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", reposition);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={menu}
      className="sidebar-page-menu"
      role={renaming ? "dialog" : "menu"}
      aria-label={renaming ? "Переименовать страницу" : "Действия со страницей"}
      style={{
        top: Math.max(8, Math.min(rect.bottom + 4, innerHeight - 160)),
        left: Math.max(8, Math.min(rect.left, innerWidth - 264)),
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          anchor.focus();
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (renaming) return;
          e.preventDefault();
          const buttons = [
            ...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ??
              []),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }
        if (e.key === "Tab" && !renaming) onClose();
      }}
    >
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) {
              onRename(note, title.trim());
              onClose();
              anchor.focus();
            }
          }}
        >
          <label htmlFor="sidebar-page-name">Название страницы</label>
          <input
            id="sidebar-page-name"
            aria-label="Новое название страницы"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
          <div className="row">
            <button type="button" className="quiet-button" onClick={onClose}>
              Отмена
            </button>
            <button className="primary-button" disabled={!title.trim()}>
              Сохранить
            </button>
          </div>
        </form>
      ) : (
        <>
          <button
            role="menuitem"
            onClick={() => {
              onFavorite(note);
              onClose();
              anchor.focus();
            }}
          >
            <Star size={15} />
            {note.favorite ? "Убрать из избранного" : "Добавить в избранное"}
          </button>
          <button role="menuitem" onClick={() => setRenaming(true)}>
            <Pencil size={15} />
            Переименовать
          </button>
          <div className="menu-separator" />
          <button
            role="menuitem"
            className="menu-delete"
            onClick={() => {
              onRemove(note);
              onClose();
            }}
          >
            <Trash2 size={15} />
            Удалить в корзину
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
