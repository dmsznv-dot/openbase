import { useEffect, useMemo, useRef, useState } from "react";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  Details,
  DetailsSummary,
  DetailsContent,
} from "@tiptap/extension-details";
import { TableKit } from "@tiptap/extension-table";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link,
  Paperclip,
  Heading1,
  List,
  ListOrdered,
  SquareCheck,
  Quote,
  Minus,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Star,
  FileCode,
  Plus,
  Image as ImageIcon,
  GripVertical,
  FilePlus2,
  FileText,
} from "lucide-react";
import type { Document, Note } from "../core/model";
import { api, assetUrl, native } from "../core/bridge";
import { attachmentPath, resolveLink } from "../core/model";
interface Props {
  doc: Document;
  draft: string;
  root: string;
  notes: Note[];
  onChange: (s: string, raw?: boolean) => void;
  onPatch: (p: Record<string, unknown>) => void;
  onOpen: (n: Note) => void;
  onError: (e: unknown) => void;
  onHistory: () => void;
  onMove: (path: string) => Promise<void>;
  onCreateChild: () => void;
}
const unsupported = (s: string) =>
  /\[\^[^\]]+\]|^\s*<(?!\/?(?:details|summary|div|p|strong|em|br|s|code)\b)[a-z!]|^\s*<!--|^:::/im.test(
    s,
  );
export function Editor({
  doc,
  draft,
  root,
  notes,
  onChange,
  onPatch,
  onOpen,
  onError,
  onHistory,
  onMove,
  onCreateChild,
}: Props) {
  const [source, setSource] = useState(!!doc.yaml_error || unsupported(draft)),
    [slash, setSlash] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [property, setProperty] = useState(""),
    [propertyValue, setPropertyValue] = useState(""),
    [linking, setLinking] = useState(false),
    [linkTarget, setLinkTarget] = useState(""),
    [upload, setUpload] = useState<number | null>(null),
    [moving, setMoving] = useState(false),
    [movePath, setMovePath] = useState(doc.path);
  const uploadBusy = useRef(false),
    mounted = useRef(true);
  const fullFileMode = useRef(!!doc.yaml_error),
    liveDraft = useRef(draft),
    liveSource = useRef(source);
  liveDraft.current = draft;
  liveSource.current = source;
  useEffect(() => {
    if (!doc.yaml_error && draft === doc.content) fullFileMode.current = false;
  }, [doc.yaml_error, doc.content, draft]);
  const callbacks = useRef({ onChange, onOpen, onError, notes, doc, root });
  callbacks.current = { onChange, onOpen, onError, notes, doc, root };
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, protocols: ["note"] },
      }),
      Markdown,
      Placeholder.configure({
        placeholder: "Напишите что-нибудь или введите / для выбора блока…",
      }),
      Image.extend({
        addNodeView() {
          return ({ node }) => {
            const img = document.createElement("img");
            img.src = assetUrl(
              callbacks.current.root,
              callbacks.current.doc.path,
              String(node.attrs.src),
            );
            img.alt = String(node.attrs.alt ?? "");
            img.addEventListener("error", () => {
              img.alt = "Изображение недоступно: " + node.attrs.src;
            });
            return { dom: img };
          };
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit,
      Details.extend({
        renderMarkdown(node, helpers) {
          const summary = node.content?.find(
            (n) => n.type === "detailsSummary",
          );
          const content = node.content?.find(
            (n) => n.type === "detailsContent",
          );
          return `<details>\n<summary>${summary ? helpers.renderChildren(summary.content ?? []) : "Подробности"}</summary>\n<div data-type="detailsContent">\n\n${content ? helpers.renderChildren(content.content ?? []) : ""}\n\n</div>\n</details>`;
        },
      }),
      DetailsSummary,
      DetailsContent,
    ],
    content: doc.yaml_error
      ? ""
      : draft.replace(
          /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
          (_, target, label) =>
            `[${label ?? target}](${encodeURI(target.replace(/#.*$/, ""))}.md)`,
        ),
    contentType: "markdown",
    immediatelyRender: true,
    editorProps: {
      attributes: {
        "aria-label": "Содержимое страницы",
        role: "textbox",
        "aria-multiline": "true",
        class: "note-body",
      },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest("a");
        if (!a) return false;
        event.preventDefault();
        const href = a.getAttribute("href") ?? "";
        const found = resolveLink(
          callbacks.current.notes,
          callbacks.current.doc,
          href,
        );
        if (found) callbacks.current.onOpen(found);
        else if (!/^[a-z]+:/i.test(href))
          void api
            .openAttachment(attachmentPath(callbacks.current.doc.path, href))
            .catch(callbacks.current.onError);
        else void api.openExternal(href).catch(callbacks.current.onError);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      callbacks.current.onChange(editor.getMarkdown());
      const pos = editor.state.selection.from;
      const before = editor.state.doc.textBetween(
        Math.max(0, pos - 80),
        pos,
        "\n",
      );
      const match = before.match(/(?:^|\s)\/([^\s/]*)$/);
      setSlash(match ? match[1] : null);
    },
  });
  useEffect(() => {
    if (!editor || doc.yaml_error) return;
    if (editor.getMarkdown() !== draft && !editor.isFocused)
      editor.commands.setContent(
        draft.replace(/\[\[([^\]]+)\]\]/g, "[$1]($1.md)"),
        { contentType: "markdown", emitUpdate: false },
      );
  }, [doc.id, doc.revision, editor]);
  const media = useMemo(
    () =>
      [
        ...draft.matchAll(
          /(?<!!)\[([^\]]+)\]\(([^)]+\.(?:mp4|mov|webm|mp3|wav|ogg|m4a|pdf))\)/gi,
        ),
      ].map((m) => ({ name: m[1], target: m[2] })),
    [draft],
  );
  const attach = async (filePath?: string) => {
    if (uploadBusy.current) return;
    uploadBusy.current = true;
    setUpload(0);
    try {
      const target = await api.attach(filePath);
      if (!target) return;
      const folderDepth = doc.path.split("/").length - 1;
      const path = "../".repeat(folderDepth) + target;
      const label = target.split("/").pop() ?? target;
      const md = /\.(png|jpe?g|gif|webp|heic|svg)$/i.test(path)
        ? `![${label}](${encodeURI(path)})`
        : `[${label}](${encodeURI(path)})`;
      if (!mounted.current) {
        const latest = await api.read(doc.path);
        await api.save(latest, latest.content + "\n\n" + md);
      } else if (liveSource.current)
        callbacks.current.onChange(
          liveDraft.current + "\n\n" + md,
          fullFileMode.current,
        );
      else editor?.commands.insertContent(md, { contentType: "markdown" });
    } catch (e) {
      onError(e);
    } finally {
      uploadBusy.current = false;
      if (mounted.current) setUpload(null);
    }
  };
  const dropAttach = useRef(attach);
  dropAttach.current = attach;
  useEffect(() => {
    mounted.current = true;
    if (!native)
      return () => {
        mounted.current = false;
      };
    let disposeDrop: (() => void) | undefined,
      disposeProgress: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async (e) => {
        if (e.payload.type === "drop")
          for (const path of e.payload.paths) await dropAttach.current(path);
      })
      .then((f) => (disposeDrop = f))
      .catch(onError);
    listen<{ copied: number; total: number }>("attachment-progress", (e) => {
      if (mounted.current)
        setUpload(
          e.payload.copied >= e.payload.total
            ? null
            : Math.round((e.payload.copied / e.payload.total) * 100),
        );
    })
      .then((f) => (disposeProgress = f))
      .catch(onError);
    return () => {
      mounted.current = false;
      disposeDrop?.();
      disposeProgress?.();
    };
  }, []);
  const commands = [
    { name: "Подстраница", icon: FilePlus2, run: onCreateChild },
    {
      name: "Заголовок 1",
      icon: Heading1,
      run: () => editor?.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      name: "Заголовок 2",
      icon: Heading1,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      name: "Список",
      icon: List,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      name: "Нумерованный список",
      icon: ListOrdered,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      name: "Задачи",
      icon: SquareCheck,
      run: () => editor?.chain().focus().toggleTaskList().run(),
    },
    {
      name: "Цитата",
      icon: Quote,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    {
      name: "Код",
      icon: Code,
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
    {
      name: "Разделитель",
      icon: Minus,
      run: () => editor?.chain().focus().setHorizontalRule().run(),
    },
    {
      name: "Сворачиваемый блок",
      icon: ChevronDown,
      run: () => editor?.chain().focus().setDetails().run(),
    },
    { name: "Изображение или файл", icon: ImageIcon, run: () => void attach() },
    {
      name: "Таблица",
      icon: List,
      run: () =>
        editor
          ?.chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
  ];
  const runCommand = (command: (typeof commands)[number]) => {
    if (editor && slash !== null) {
      const pos = editor.state.selection.from;
      editor
        .chain()
        .focus()
        .deleteRange({ from: pos - slash.length - 1, to: pos })
        .run();
    }
    setSlash(null);
    command.run();
  };
  const move = (direction: number) => {
    if (!editor) return;
    const { $from } = editor.state.selection;
    const index = $from.index(0);
    const count = editor.state.doc.childCount;
    if (index + direction < 0 || index + direction >= count) return;
    const blocks = editor.getJSON().content ?? [];
    [blocks[index], blocks[index + direction]] = [
      blocks[index + direction],
      blocks[index],
    ];
    editor.commands.setContent({ type: "doc", content: blocks });
  };
  const setLink = () => {
    const target = linkTarget.trim();
    if (!target) return;
    if (/^(javascript|data|file):/i.test(target)) {
      onError("Этот адрес нельзя использовать как ссылку");
      return;
    }
    editor?.chain().focus().setLink({ href: target }).run();
    setLinking(false);
    setLinkTarget("");
  };
  return (
    <div className="editor-scroll">
      <article className="document">
        <div className="document-meta">
          <button
            className="quiet-button path-button"
            title="Переименовать или переместить файл"
            onClick={() => setMoving((s) => !s)}
          >
            {doc.path}
          </button>
          <div className="row">
            <button
              className={"icon-button " + (doc.favorite ? "favorite" : "")}
              title="В избранное"
              aria-label="В избранное"
              onClick={() =>
                onPatch({ localnotes: { favorite: !doc.favorite } })
              }
            >
              <Star size={17} fill={doc.favorite ? "currentColor" : "none"} />
            </button>
            <button className="quiet-button" onClick={onHistory}>
              История
            </button>
            <button
              className={"quiet-button " + (source ? "selected" : "")}
              onClick={() => {
                if (fullFileMode.current) return;
                if (source) {
                  if (unsupported(draft)) {
                    onError(
                      "Этот Markdown содержит неподдерживаемые конструкции. Продолжите в исходном режиме.",
                    );
                    return;
                  }
                  editor?.commands.setContent(
                    draft.replace(/\[\[([^\]]+)\]\]/g, "[$1]($1.md)"),
                    { contentType: "markdown", emitUpdate: false },
                  );
                }
                setSource((s) => !s);
              }}
              title="Переключить Markdown"
            >
              <FileCode size={15} />
              Markdown
            </button>
          </div>
        </div>
        {moving ? (
          <form
            className="row link-form"
            onSubmit={(e) => {
              e.preventDefault();
              void onMove(movePath)
                .then(() => setMoving(false))
                .catch(onError);
            }}
          >
            <input
              aria-label="Новый путь файла"
              placeholder="Папка/Страница.md"
              value={movePath}
              onChange={(e) => setMovePath(e.target.value)}
            />
            <button className="quiet-button">Переместить</button>
            <button
              type="button"
              className="quiet-button"
              onClick={() => setMoving(false)}
            >
              Отмена
            </button>
          </form>
        ) : null}
        <input
          className="page-title"
          aria-label="Название страницы"
          value={doc.title}
          onChange={(e) => onPatch({ title: e.target.value })}
          placeholder="Без названия"
        />
        <div className="properties">
          <div className="property-row">
            <label htmlFor="page-tags">Теги</label>
            <input
              id="page-tags"
              key={doc.path + "tags"}
              defaultValue={doc.tags.join(", ")}
              onBlur={(e) =>
                onPatch({
                  tags: e.target.value
                    .split(",")
                    .map((t) => t.trim().replace(/^#/, ""))
                    .filter(Boolean),
                })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              placeholder="проект, идея, исследование"
            />
          </div>
          <div className="property-row">
            <label htmlFor="page-status">Статус</label>
            <input
              id="page-status"
              key={doc.path + "status"}
              defaultValue={String(doc.properties.status ?? "")}
              onBlur={(e) => onPatch({ status: e.target.value })}
              placeholder="Без статуса"
            />
          </div>
          {Object.entries(doc.properties)
            .filter(
              ([k]) => !["title", "tags", "status", "localnotes"].includes(k),
            )
            .map(([k, v]) => (
              <div className="property-row" key={k}>
                <label>{k}</label>
                <input
                  defaultValue={
                    typeof v === "object" ? JSON.stringify(v) : String(v ?? "")
                  }
                  onBlur={(e) => {
                    let value: unknown = e.target.value;
                    try {
                      value = JSON.parse(e.target.value);
                    } catch {}
                    onPatch({ [k]: value });
                  }}
                />
              </div>
            ))}
          {adding ? (
            <form
              className="row property-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (
                  property &&
                  !["localnotes", "title", "tags", "status"].includes(property)
                ) {
                  let v: unknown = propertyValue;
                  try {
                    v = JSON.parse(propertyValue);
                  } catch {}
                  onPatch({ [property]: v });
                  setAdding(false);
                  setProperty("");
                  setPropertyValue("");
                }
              }}
            >
              <input
                aria-label="Название свойства"
                placeholder="Свойство"
                value={property}
                onChange={(e) => setProperty(e.target.value)}
              />
              <input
                aria-label="Значение свойства"
                placeholder="Значение"
                value={propertyValue}
                onChange={(e) => setPropertyValue(e.target.value)}
              />
              <button className="quiet-button">Добавить</button>
              <button
                type="button"
                className="quiet-button"
                onClick={() => setAdding(false)}
              >
                Отмена
              </button>
            </form>
          ) : (
            <button className="add-property" onClick={() => setAdding(true)}>
              <Plus size={13} />
              Добавить свойство
            </button>
          )}
        </div>
        {upload !== null ? (
          <div className="upload-progress">
            <progress value={upload} max={100} />
            <span>Копирование · {upload}%</span>
            <button
              className="quiet-button"
              onClick={() => void api.cancelAttachment().catch(onError)}
            >
              Отменить
            </button>
          </div>
        ) : null}
        {doc.yaml_error ? (
          <div className="inline-warning">
            Ошибка YAML. Редактируется полный исходный файл: {doc.yaml_error}
          </div>
        ) : null}
        {!source ? (
          <div className="format-toolbar" aria-label="Форматирование">
            <button
              title="Жирный"
              aria-label="Жирный"
              className={editor?.isActive("bold") ? "active" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            >
              <Bold size={16} />
            </button>
            <button
              title="Курсив"
              aria-label="Курсив"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
              <Italic size={16} />
            </button>
            <button
              title="Зачёркнутый"
              aria-label="Зачёркнутый"
              onClick={() => editor?.chain().focus().toggleStrike().run()}
            >
              <Strikethrough size={16} />
            </button>
            <button
              title="Встроенный код"
              aria-label="Встроенный код"
              onClick={() => editor?.chain().focus().toggleCode().run()}
            >
              <Code size={16} />
            </button>
            <span className="toolbar-separator" />
            <button
              title="Ссылка"
              aria-label="Вставить ссылку"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setLinking((s) => !s)}
            >
              <Link size={16} />
            </button>
            <button
              title="Добавить вложение"
              aria-label="Добавить вложение"
              onClick={() => void attach()}
            >
              <Paperclip size={16} />
            </button>
            <span className="toolbar-separator" />
            <button
              title="Блок вверх"
              aria-label="Блок вверх"
              onClick={() => move(-1)}
            >
              <ArrowUp size={16} />
            </button>
            <button
              title="Блок вниз"
              aria-label="Блок вниз"
              onClick={() => move(1)}
            >
              <ArrowDown size={16} />
            </button>
          </div>
        ) : null}
        {linking ? (
          <form
            className="row link-form"
            onSubmit={(e) => {
              e.preventDefault();
              setLink();
            }}
          >
            <input
              autoFocus
              aria-label="Адрес ссылки"
              placeholder="Имя страницы.md или https://…"
              value={linkTarget}
              onChange={(e) => setLinkTarget(e.target.value)}
            />
            <button className="quiet-button">Добавить ссылку</button>
            <button
              type="button"
              className="quiet-button"
              onClick={() => setLinking(false)}
            >
              Отмена
            </button>
          </form>
        ) : null}
        <div
          className="editor-container"
          onKeyDown={(e) => {
            if (e.key === "Escape") setSlash(null);
          }}
        >
          {source ? (
            <textarea
              className="markdown-source"
              aria-label="Исходный Markdown"
              value={draft}
              onChange={(e) => onChange(e.target.value, fullFileMode.current)}
              spellCheck={false}
            />
          ) : (
            <>
              <EditorContent editor={editor} />
              {editor ? (
                <DragHandle editor={editor} nested>
                  <button
                    className="drag-block"
                    aria-label="Переместить блок"
                    title="Перетащить блок"
                  >
                    <GripVertical size={16} />
                  </button>
                </DragHandle>
              ) : null}
            </>
          )}
          {slash !== null && !source ? (
            <div className="slash-menu" role="menu">
              {commands
                .filter((c) =>
                  c.name
                    .toLocaleLowerCase()
                    .includes(slash.toLocaleLowerCase()),
                )
                .map((c) => (
                  <button
                    key={c.name}
                    role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runCommand(c)}
                  >
                    <c.icon size={17} />
                    {c.name}
                  </button>
                ))}
            </div>
          ) : null}
        </div>
        {media.length ? (
          <div className="media-list">
            {media.map((m, i) => (
              <div className="media-item" key={i}>
                {/\.(mp4|mov|webm)$/i.test(m.target) ? (
                  <video
                    controls
                    preload="metadata"
                    src={assetUrl(root, doc.path, m.target)}
                  />
                ) : /\.(mp3|wav|ogg|m4a)$/i.test(m.target) ? (
                  <audio
                    controls
                    preload="metadata"
                    src={assetUrl(root, doc.path, m.target)}
                  />
                ) : null}
                <button
                  className="quiet-button"
                  onClick={() =>
                    void api
                      .openAttachment(attachmentPath(doc.path, m.target))
                      .catch(onError)
                  }
                >
                  <Paperclip size={15} />
                  {m.name}
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {notes.some((n) => n.parent_id === doc.id && n.id !== doc.id) ? (
          <section className="subpages" aria-label="Вложенные страницы">
            <h2>Вложенные страницы</h2>
            {notes
              .filter((n) => n.parent_id === doc.id && n.id !== doc.id)
              .map((n) => (
                <button key={n.path} onClick={() => onOpen(n)}>
                  <FileText size={16} />
                  {n.title}
                </button>
              ))}
          </section>
        ) : null}
        <div className="backlinks">
          <span>Обратные ссылки</span>
          {notes
            .filter(
              (n) =>
                n.id !== doc.id &&
                n.links.some((l) => resolveLink(notes, n, l)?.id === doc.id),
            )
            .map((n) => (
              <button key={n.id} onClick={() => onOpen(n)}>
                {n.title}
              </button>
            ))}
        </div>
      </article>
    </div>
  );
}
