import { useEffect, useRef, useState, useCallback } from "react";
import { api, native, type WorkspaceInfo } from "../core/bridge";
import { SaveQueue } from "../core/saveQueue";
import {
  pageViewPatch,
  type Document,
  type Note,
  type DataView,
  type PageView,
} from "../core/model";
import { getCurrentWindow } from "@tauri-apps/api/window";
const defaultView: DataView = {
  id: "all",
  name: "Все страницы",
  tags: [],
  match: "any",
  layout: "table",
  sort: "updated",
  groupBy: "status",
};
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null),
    [notes, setNotes] = useState<Note[]>([]),
    [views, setViews] = useState<DataView[]>([]),
    [doc, setDoc] = useState<Document | null>(null),
    [draft, setDraft] = useState(""),
    [status, setStatus] = useState("Сохранено"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [tabs, setTabs] = useState<Note[]>([]);
  const queue = useRef(new SaveQueue(api.save)),
    current = useRef<Document | null>(null),
    text = useRef(""),
    dirty = useRef(false),
    raw = useRef(false),
    props = useRef<Record<string, unknown>>({}),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    maxTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    generation = useRef(0),
    blocked = useRef(false),
    navigation = useRef(0);
  const clearTimers = () => {
    if (timer.current) clearTimeout(timer.current);
    if (maxTimer.current) clearTimeout(maxTimer.current);
    timer.current = maxTimer.current = null;
  };
  const report = useCallback((e: unknown) => {
    setError(String(e));
  }, []);
  const refresh = useCallback(async () => {
    const n = await api.list();
    setNotes(n);
    return n;
  }, []);
  const accept = useCallback((d: Document) => {
    queue.current.accept(d);
    current.current = d;
    text.current = d.yaml_error ? d.raw : d.content;
    raw.current = !!d.yaml_error;
    props.current = {};
    dirty.current = false;
    blocked.current = false;
    generation.current++;
    setDoc(d);
    setDraft(text.current);
    setStatus("Сохранено");
    setTabs((t) =>
      t.some((n) => n.path === d.path)
        ? t.map((n) => (n.path === d.path ? d : n))
        : [...t, d],
    );
  }, []);
  const save = useCallback(async () => {
    clearTimers();
    const d = current.current;
    if (!d || !dirty.current) return;
    if (blocked.current) throw Error("Сначала разрешите конфликт сохранения");
    const content = text.current,
      patch = props.current,
      version = generation.current;
    dirty.current = false;
    props.current = {};
    setStatus("Сохранение…");
    try {
      const saved = await queue.current.write(d, content, patch, raw.current);
      if (current.current?.path === d.path) {
        current.current = saved;
        setDoc(saved);
        if (
          raw.current &&
          !saved.yaml_error &&
          generation.current === version
        ) {
          text.current = saved.content;
          raw.current = false;
          setDraft(saved.content);
        }
        setStatus(generation.current === version ? "Сохранено" : "Изменения");
      }
      setNotes((n) => n.map((x) => (x.path === saved.path ? saved : x)));
      setTabs((t) => t.map((x) => (x.path === saved.path ? saved : x)));
    } catch (e) {
      if (current.current?.path === d.path) {
        dirty.current = true;
        props.current = { ...patch, ...props.current };
        blocked.current = String(e).includes("CONFLICT:");
        setStatus(blocked.current ? "Конфликт" : "Ошибка сохранения");
      }
      report(e);
      throw e;
    }
  }, [report]);
  const flush = useCallback(async () => {
    clearTimers();
    do {
      if (dirty.current) await save();
      await queue.current.flush();
    } while (dirty.current);
  }, [save]);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void save().catch(() => {});
    }, 500);
    if (!maxTimer.current)
      maxTimer.current = setTimeout(() => {
        void save().catch(() => {});
      }, 2000);
  }, [save]);
  const change = useCallback(
    (value: string, rawMode = false) => {
      text.current = value;
      raw.current = rawMode;
      dirty.current = true;
      generation.current++;
      setDraft(value);
      setStatus("Изменения");
      if (!blocked.current) schedule();
    },
    [schedule],
  );
  const patch = useCallback(
    (value: Record<string, unknown>) => {
      props.current = {
        ...props.current,
        ...value,
        ...(value.localnotes
          ? {
              localnotes: {
                ...((props.current.localnotes as object) ?? {}),
                ...(value.localnotes as object),
              },
            }
          : {}),
      };
      dirty.current = true;
      generation.current++;
      if (current.current) {
        const d = current.current;
        const optimistic = {
          ...d,
          title: String(value.title ?? d.title),
          tags: Array.isArray(value.tags) ? (value.tags as string[]) : d.tags,
          favorite:
            typeof (value.localnotes as { favorite?: unknown } | undefined)
              ?.favorite === "boolean"
              ? (value.localnotes as { favorite: boolean }).favorite
              : d.favorite,
          properties: {
            ...d.properties,
            ...value,
            ...(value.localnotes
              ? {
                  localnotes: {
                    ...((d.properties.localnotes as object) ?? {}),
                    ...(value.localnotes as object),
                  },
                }
              : {}),
          },
        };
        current.current = optimistic;
        setDoc(optimistic);
      }
      setStatus("Изменения");
      schedule();
    },
    [schedule],
  );
  const open = useCallback(
    async (n: Note) => {
      try {
        const request = ++navigation.current;
        await flush();
        if (current.current?.path === n.path) return true;
        const loaded = await api.read(n.path);
        await flush();
        if (request !== navigation.current) return false;
        accept(loaded);
        return true;
      } catch (e) {
        report(e);
        return false;
      }
    },
    [flush, accept, report],
  );
  const setPageView = useCallback(
    async (view: PageView, expectedPath: string) => {
      try {
        await flush();
        if (current.current?.path === expectedPath)
          patch(pageViewPatch(current.current, view));
      } catch (e) {
        report(e);
      }
    },
    [flush, patch, report],
  );
  const patchNote = useCallback(
    async (n: Note, value: Record<string, unknown>) => {
      try {
        await flush();
        if (current.current?.path === n.path) {
          patch(value);
          await flush();
        } else {
          const d = await api.read(n.path);
          const saved = await api.save(d, d.content, value);
          if (current.current?.path === n.path && !dirty.current) accept(saved);
          setTabs((t) => t.map((x) => (x.path === n.path ? saved : x)));
          await refresh();
        }
      } catch (e) {
        report(e);
      }
    },
    [flush, patch, accept, refresh, report],
  );
  const install = useCallback((w: WorkspaceInfo) => {
    current.current = null;
    setDoc(null);
    setTabs([]);
    setWorkspace(w);
    setNotes(w.notes);
    setViews(w.views.length ? w.views : [defaultView]);
  }, []);
  useEffect(() => {
    api
      .initial()
      .then((w) => {
        if (w) install(w);
      })
      .catch(report)
      .finally(() => setLoading(false));
    return clearTimers;
  }, [install, report]);
  const openVault = useCallback(async () => {
    try {
      await flush();
      setLoading(true);
      const w = await api.openVault();
      if (w) install(w);
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  }, [flush, install, report]);
  const create = useCallback(
    async (parent?: string) => {
      try {
        await flush();
        const d = await api.create("Без названия", parent);
        await refresh();
        accept(d);
        return d;
      } catch (e) {
        report(e);
      }
    },
    [flush, refresh, accept, report],
  );
  const updateViews = useCallback(
    async (next: DataView[]) => {
      try {
        await api.saveViews(next);
        setViews(next);
      } catch (e) {
        report(e);
      }
    },
    [report],
  );
  const remove = useCallback(
    async (n: Note) => {
      try {
        await flush();
        await api.trash(n.path);
        if (current.current?.path === n.path) {
          current.current = null;
          setDoc(null);
          setDraft("");
        }
        setTabs((t) => t.filter((x) => x.path !== n.path));
        await refresh();
      } catch (e) {
        report(e);
      }
    },
    [flush, refresh, report],
  );
  const reload = useCallback(async () => {
    if (current.current) {
      clearTimers();
      dirty.current = false;
      accept(await api.read(current.current.path));
      setError("");
    }
  }, [accept]);
  const saveCopy = useCallback(async () => {
    const old = current.current;
    if (!old) return;
    try {
      const d = await api.create(old.title + " — копия");
      const saved = await api.save(
        d,
        text.current,
        {
          ...old.properties,
          ...props.current,
          title: String(props.current.title ?? old.title) + " — копия",
          localnotes: {
            favorite: old.favorite,
            ...((props.current.localnotes as object) ?? {}),
          },
        },
        raw.current,
      );
      dirty.current = false;
      accept(saved);
      setError("");
      await refresh();
    } catch (e) {
      report(e);
    }
  }, [accept, refresh, report]);
  useEffect(() => {
    if (!workspace) return;
    let active = true;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const n = await api.list();
        if (!active) return;
        setNotes(n);
        const d = current.current;
        const changed =
          d && n.find((x) => x.path === d.path && x.revision !== d.revision);
        if (changed && !dirty.current && !blocked.current) {
          const version = generation.current;
          const fresh = await api.read(changed.path);
          if (
            active &&
            !dirty.current &&
            generation.current === version &&
            current.current?.path === fresh.path
          )
            accept(fresh);
        }
      } catch (e) {
        if (active) report(e);
      } finally {
        running = false;
      }
    };
    const id = setInterval(tick, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [workspace, accept, report]);
  useEffect(() => {
    if (!native) return;
    let unlisten: (() => void) | undefined;
    let closing = false;
    getCurrentWindow()
      .onCloseRequested(async (e) => {
        if (closing) return;
        e.preventDefault();
        try {
          await flush();
          closing = true;
          await getCurrentWindow().close();
        } catch (err) {
          report(err);
        }
      })
      .then((f) => (unlisten = f));
    return () => unlisten?.();
  }, [flush, report]);
  return {
    workspace,
    notes,
    views,
    doc,
    draft,
    status,
    error,
    loading,
    tabs,
    setTabs,
    setError,
    report,
    open,
    create,
    openVault,
    change,
    patch,
    patchNote,
    setPageView,
    flush,
    refresh,
    accept,
    updateViews,
    remove,
    reload,
    saveCopy,
  };
}
