import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { fsListDir, fsRead, fsWrite, fsDelete } from "./api";
import type { FileEntry } from "./api";
import { useVault } from "./vault";

/**
 * 清单数据层（M4）：data/checklists/<id>.json
 *
 * - 文件即数据：一个清单一个 JSON 文件，普通文件可 git、可迁移
 * - 自动保存（800ms 防抖，与笔记一致）
 * - 维护"笔记引用索引"供笔记视图反链
 */

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** 关联笔记（vault 相对路径） */
  note?: string;
}

export interface Checklist {
  id: string; // 文件名（不含 .json）
  title: string;
  createdAt: string;
  updatedAt: string;
  items: ChecklistItem[];
}

export interface ChecklistMeta {
  id: string;
  title: string;
  done: number;
  total: number;
  updatedAt: string;
}

interface ChecklistContextValue {
  metas: ChecklistMeta[];
  current: Checklist | null;
  loading: boolean;
  refresh: () => Promise<void>;
  open: (id: string) => Promise<void>;
  create: (title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  rename: (title: string) => void;
  save: () => Promise<void>;
  addItem: (text: string) => void;
  toggleItem: (id: string) => void;
  removeItem: (id: string) => void;
  updateItem: (id: string, text: string) => void;
  setItemNote: (id: string, note: string | undefined) => void;
  /** 笔记路径 → 引用它的清单条目（反链索引） */
  backlinks: Map<string, { checklistId: string; title: string }[]>;
}

const ChecklistContext = createContext<ChecklistContextValue | null>(null);

export function useChecklists(): ChecklistContextValue {
  const ctx = useContext(ChecklistContext);
  if (!ctx) throw new Error("useChecklists 必须在 ChecklistProvider 内使用");
  return ctx;
}

const AUTOSAVE = 800;
const DIR = "data/checklists";

export function ChecklistProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const isMock = useMemo(
    () => new URLSearchParams(window.location.search).has("mock"),
    []
  );
  const vaultRef = useRef(vault.path);
  vaultRef.current = vault.path;

  const [metas, setMetas] = useState<ChecklistMeta[]>([]);
  const [current, setCurrent] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(false);
  const [backlinks, setBacklinks] = useState<
    Map<string, { checklistId: string; title: string }[]>
  >(new Map());

  const currentRef = useRef<Checklist | null>(null);
  currentRef.current = current;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- mock 模式：localStorage 持久化示例数据 ---- */
  const mockKey = "toolbox.mock.checklists";
  const mockLoad = useCallback((): Checklist[] => {
    const raw = localStorage.getItem(mockKey);
    if (raw) {
      try {
        return JSON.parse(raw) as Checklist[];
      } catch {
        /* 损坏则重建 */
      }
    }
    const now = new Date().toISOString();
    const seed: Checklist[] = [
      {
        id: "zhou-ji-hua",
        title: "周计划",
        createdAt: now,
        updatedAt: now,
        items: [
          { id: "i1", text: "完成 M4 清单与记录", done: false, note: "示例笔记.md" },
          { id: "i2", text: "整理数据工具文档", done: true },
          { id: "i3", text: "备份工作区", done: false },
        ],
      },
      {
        id: "gou-wu",
        title: "采购清单",
        createdAt: now,
        updatedAt: now,
        items: [
          { id: "i1", text: "机械键盘", done: true },
          { id: "i2", text: "显示器支架", done: false },
        ],
      },
    ];
    localStorage.setItem(mockKey, JSON.stringify(seed));
    return seed;
  }, []);

  /* ---- 真实模式：枚举 + 读取 ---- */
  const loadReal = useCallback(async (): Promise<Checklist[]> => {
    const p = vaultRef.current;
    if (!p) return [];
    const list: FileEntry[] = await fsListDir(p, DIR);
    const files = list.filter((f) => !f.isDir && f.path.endsWith(".json"));
    const out: Checklist[] = [];
    for (const f of files) {
      try {
        const raw = await fsRead(p, f.path);
        out.push(JSON.parse(raw) as Checklist);
      } catch (e) {
        console.error(`[checklists] 读取失败 ${f.path}`, e);
      }
    }
    return out;
  }, []);

  const refresh = useCallback(async () => {
    if (isMock) {
      const all = mockLoad();
      setMetas(
        all
          .map((c) => ({
            id: c.id,
            title: c.title,
            done: c.items.filter((i) => i.done).length,
            total: c.items.length,
            updatedAt: c.updatedAt,
          }))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      );
      buildBacklinks(all);
      return;
    }
    setLoading(true);
    try {
      const all = await loadReal();
      setMetas(
        all
          .map((c) => ({
            id: c.id,
            title: c.title,
            done: c.items.filter((i) => i.done).length,
            total: c.items.length,
            updatedAt: c.updatedAt,
          }))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      );
      buildBacklinks(all);
    } catch (e) {
      console.error("[checklists] 刷新失败", e);
    } finally {
      setLoading(false);
    }
  }, [isMock, mockLoad, loadReal]);

  const buildBacklinks = useCallback((all: Checklist[]) => {
    const map = new Map<string, { checklistId: string; title: string }[]>();
    for (const c of all) {
      for (const item of c.items) {
        if (item.note) {
          const key = item.note.replace(/^\/+/, "");
          const list = map.get(key) ?? [];
          list.push({ checklistId: c.id, title: c.title });
          map.set(key, list);
        }
      }
    }
    setBacklinks(map);
  }, []);

  /* ---- 写入（真实写文件；mock 写 localStorage） ---- */
  const persist = useCallback(
    async (list: Checklist) => {
      if (isMock) {
        const all = mockLoad();
        const idx = all.findIndex((c) => c.id === list.id);
        if (idx >= 0) all[idx] = list;
        else all.push(list);
        localStorage.setItem(mockKey, JSON.stringify(all));
        return;
      }
      const p = vaultRef.current;
      if (!p) return;
      await fsWrite(p, `${DIR}/${list.id}.json`, JSON.stringify(list, null, 2));
    },
    [isMock, mockLoad]
  );

  const save = useCallback(async () => {
    const cur = currentRef.current;
    if (!cur) return;
    const updated = { ...cur, updatedAt: new Date().toISOString() };
    try {
      await persist(updated);
      setCurrent(updated);
      await refresh();
    } catch (e) {
      console.error("[checklists] 保存失败", e);
    }
  }, [persist, refresh]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(), AUTOSAVE);
  }, [save]);

  const mutate = useCallback((fn: (c: Checklist) => Checklist) => {
    setCurrent((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      scheduleSave();
      return next;
    });
  }, [scheduleSave]);

  const open = useCallback(
    async (id: string) => {
      if (isMock) {
        const all = mockLoad();
        const c = all.find((x) => x.id === id) ?? null;
        setCurrent(c);
        return;
      }
      const p = vaultRef.current;
      if (!p) return;
      try {
        const raw = await fsRead(p, `${DIR}/${id}.json`);
        setCurrent(JSON.parse(raw) as Checklist);
      } catch (e) {
        console.error(`[checklists] 打开失败 ${id}`, e);
      }
    },
    [isMock, mockLoad]
  );

  const create = useCallback(
    async (title: string) => {
      const t = title.trim();
      if (!t) return;
      const now = new Date().toISOString();
      const id = t
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || `list-${Date.now().toString(36)}`;
      const list: Checklist = {
        id,
        title: t,
        createdAt: now,
        updatedAt: now,
        items: [],
      };
      await persist(list);
      await refresh();
      await open(id);
    },
    [persist, refresh, open]
  );

  const remove = useCallback(
    async (id: string) => {
      if (isMock) {
        const all = mockLoad().filter((c) => c.id !== id);
        localStorage.setItem(mockKey, JSON.stringify(all));
      } else {
        const p = vaultRef.current;
        if (p) {
          try {
            await fsDelete(p, `${DIR}/${id}.json`);
          } catch (e) {
            console.error(`[checklists] 删除失败 ${id}`, e);
          }
        }
      }
      if (currentRef.current?.id === id) setCurrent(null);
      await refresh();
    },
    [isMock, mockLoad, refresh]
  );

  const rename = useCallback(
    (title: string) => {
      const t = title.trim();
      if (!t) return;
      mutate((c) => ({ ...c, title: t }));
    },
    [mutate]
  );

  const addItem = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      mutate((c) => ({
        ...c,
        items: [
          ...c.items,
          {
            id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            text: t,
            done: false,
          },
        ],
      }));
    },
    [mutate]
  );

  const toggleItem = useCallback(
    (id: string) => {
      mutate((c) => ({
        ...c,
        items: c.items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)),
      }));
    },
    [mutate]
  );

  const removeItem = useCallback(
    (id: string) => {
      mutate((c) => ({ ...c, items: c.items.filter((i) => i.id !== id) }));
    },
    [mutate]
  );

  const updateItem = useCallback(
    (id: string, text: string) => {
      mutate((c) => ({
        ...c,
        items: c.items.map((i) => (i.id === id ? { ...i, text } : i)),
      }));
    },
    [mutate]
  );

  const setItemNote = useCallback(
    (id: string, note: string | undefined) => {
      mutate((c) => ({
        ...c,
        items: c.items.map((i) =>
          i.id === id ? { ...i, note: note || undefined } : i
        ),
      }));
    },
    [mutate]
  );

  /* 首次进入 / 工作区切换时刷新 */
  useEffect(() => {
    void refresh();
  }, [refresh, vault.path]);

  const value: ChecklistContextValue = {
    metas,
    current,
    loading,
    refresh,
    open,
    create,
    remove,
    rename,
    save,
    addItem,
    toggleItem,
    removeItem,
    updateItem,
    setItemNote,
    backlinks,
  };

  return (
    <ChecklistContext.Provider value={value}>
      {children}
    </ChecklistContext.Provider>
  );
}
