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
import { pluginCall } from "./api";
import { useVault } from "./vault";

/**
 * 清单数据层（M4）：data/checklists/<id>.json
 *
 * - 文件即数据：一个清单一个 JSON 文件，普通文件可 git、可迁移
 * - 自动保存（800ms 防抖，与笔记一致）
 * - 维护"笔记引用索引"供笔记视图反链
 *
 * 数据层已下沉为原生核心插件（core-checklists，cdylib）：CRUD 在宿主
 * 进程内经 FFI 完成；变更事件 chk-changed 经 plugin-event 桥推送。
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

  /* ---- 真实模式：经 core-checklists 原生插件 ---- */
  const loadReal = useCallback(async (): Promise<Checklist[]> => {
    const p = vaultRef.current;
    if (!p) return [];
    return (await pluginCall(p, "core-checklists", "chk.list", {})) as Checklist[];
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

  /* ---- 写入（真实经插件；mock 写 localStorage） ---- */
  const persist = useCallback(
    async (list: Checklist): Promise<Checklist | null> => {
      if (isMock) {
        const all = mockLoad();
        const idx = all.findIndex((c) => c.id === list.id);
        if (idx >= 0) all[idx] = list;
        else all.push(list);
        localStorage.setItem(mockKey, JSON.stringify(all));
        return list;
      }
      const p = vaultRef.current;
      if (!p) return null;
      // 插件统一刷新 updatedAt，返回更新后的清单
      return (await pluginCall(p, "core-checklists", "chk.save", {
        checklist: list,
      })) as Checklist;
    },
    [isMock, mockLoad]
  );

  /* 待保存快照：调度时捕获，避免切换清单/工作区后写错对象 */
  const pendingRef = useRef<Checklist | null>(null);

  const save = useCallback(
    async (list?: Checklist) => {
      const snapshot = list ?? pendingRef.current ?? currentRef.current;
      if (!snapshot) return;
      pendingRef.current = null;
      const updated = { ...snapshot, updatedAt: new Date().toISOString() };
      try {
        const saved = await persist(updated);
        // 仅当当前仍显示该清单时同步 UI（其余场景由后续刷新兜底）
        setCurrent((prev) =>
          saved && prev && prev.id === saved.id ? { ...saved } : prev
        );
        await refresh();
      } catch (e) {
        console.error("[checklists] 保存失败", e);
        // 保留待保存快照，供重试
        pendingRef.current = snapshot;
      }
    },
    [persist, refresh]
  );

  const flush = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const s = pendingRef.current;
    if (s) void save(s);
  }, [save]);

  const scheduleSave = useCallback(
    (snapshot: Checklist) => {
      pendingRef.current = snapshot;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const s = pendingRef.current;
        pendingRef.current = null;
        if (s) void save(s);
      }, AUTOSAVE);
    },
    [save]
  );

  /* 变更：在 updater 外基于最新已提交状态计算 next，副作用（调度保存）移出 updater */
  const mutate = useCallback(
    (fn: (c: Checklist) => Checklist) => {
      const cur = currentRef.current;
      if (!cur) return;
      const next = fn(cur);
      setCurrent(next);
      scheduleSave(next);
    },
    [scheduleSave]
  );

  const open = useCallback(
    async (id: string) => {
      // 切换前冲洗当前清单的待保存编辑，避免定时器触发时写错对象
      flush();
      if (isMock) {
        const all = mockLoad();
        const c = all.find((x) => x.id === id) ?? null;
        setCurrent(c);
        return;
      }
      const p = vaultRef.current;
      if (!p) return;
      try {
        const c = (await pluginCall(p, "core-checklists", "chk.get", {
          id,
        })) as Checklist | null;
        setCurrent(c);
      } catch (e) {
        console.error(`[checklists] 打开失败 ${id}`, e);
      }
    },
    [isMock, mockLoad, flush]
  );

  const create = useCallback(
    async (title: string) => {
      const t = title.trim();
      if (!t) return;
      if (isMock) {
        const now = new Date().toISOString();
        let id = t
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || `list-${Date.now().toString(36)}`;
        // 同名标题冲突：追加序号，避免覆盖已有清单文件
        let n = 2;
        const base = id;
        while (metas.some((m) => m.id === id)) {
          id = `${base}-${n++}`;
        }
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
        return;
      }
      const p = vaultRef.current;
      if (!p) return;
      // 插件负责 id 生成与同名冲突加序号
      const r = (await pluginCall(p, "core-checklists", "chk.create", {
        title: t,
      })) as Checklist;
      await refresh();
      await open(r.id);
    },
    [persist, refresh, open, metas, isMock]
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
            await pluginCall(p, "core-checklists", "chk.delete", { id });
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

  /* 原生插件写操作后推送 chk-changed，本层监听刷新（多窗口一致） */
  useEffect(() => {
    let un: (() => void) | null = null;
    import("@tauri-apps/api/event")
      .then((m) =>
        m.listen<{ pluginId: string; event: string }>("plugin-event", (e) => {
          const payload = e.payload;
          if (payload.pluginId === "core-checklists" && payload.event === "chk-changed") {
            void refresh();
          }
        })
      )
      .then((fn) => (un = fn))
      .catch(() => {
        /* 浏览器预览环境无事件桥 */
      });
    return () => un?.();
  }, [refresh]);

  const value: ChecklistContextValue = useMemo(
    () => ({
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
    }),
    [
      metas, current, loading, refresh, open, create, remove, rename, save,
      addItem, toggleItem, removeItem, updateItem, setItemNote, backlinks,
    ]
  );

  return (
    <ChecklistContext.Provider value={value}>
      {children}
    </ChecklistContext.Provider>
  );
}
