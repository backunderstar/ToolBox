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
 * 工作记录数据层（M4）：data/records/<id>.json
 *
 * - 一条记录一个 JSON 文件；date 按天分组，tags 用于筛选统计
 * - content 支持 [[笔记路径]] 语法，与笔记双向链接
 * - 自动保存（防抖）
 *
 * 记录已下沉为原生核心插件（core-records，cdylib）：批量 CRUD 在宿主
 * 进程内经 FFI 完成，不再逐文件走 IPC；变更事件 records-changed 经
 * plugin-event 桥推送，本层监听后刷新。
 */

export interface RecordData {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  tags: string[];
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface RecordsContextValue {
  records: RecordData[];
  loading: boolean;
  refresh: () => Promise<void>;
  create: (partial?: Partial<RecordData>) => Promise<RecordData | null>;
  save: (record: RecordData) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** 笔记路径 → 引用它的记录（反链索引） */
  backlinks: Map<string, { recordId: string; title: string }[]>;
  /** 内容里的 [[笔记]] 链接 */
  extractLinks: (content: string) => string[];
}

const RecordsContext = createContext<RecordsContextValue | null>(null);

export function useRecords(): RecordsContextValue {
  const ctx = useContext(RecordsContext);
  if (!ctx) throw new Error("useRecords 必须在 RecordsProvider 内使用");
  return ctx;
}

export function RecordsProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const isMock = useMemo(
    () => new URLSearchParams(window.location.search).has("mock"),
    []
  );
  const vaultRef = useRef(vault.path);
  vaultRef.current = vault.path;

  const [records, setRecords] = useState<RecordData[]>([]);
  const [loading, setLoading] = useState(false);

  /* 反链索引由 records 派生（useMemo），从根上避免手工维护导致的过期问题 */
  const backlinks = useMemo(() => buildIndex(records), [records]);

  const mockKey = "toolbox.mock.records";
  const mockLoad = useCallback((): RecordData[] => {
    const raw = localStorage.getItem(mockKey);
    if (raw) {
      try {
        return JSON.parse(raw) as RecordData[];
      } catch {
        /* 损坏则重建 */
      }
    }
    const now = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const seed: RecordData[] = [
      {
        id: "r1",
        title: "完成 M4 双向链接设计",
        date: today,
        tags: ["开发"],
        content: "确定了 data/checklists 与 data/records 的 JSON 结构。\n\n参考 [[示例笔记.md]] 里的拆解。",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "r2",
        title: "整理 M3 数据工具收尾",
        date: yesterday,
        tags: ["开发", "收尾"],
        content: "修复了 CommandTry 抽取后的面板定位问题。",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "r3",
        title: "本周例会记录",
        date: yesterday,
        tags: ["会议"],
        content: "下周目标：完成 M4。",
        createdAt: now,
        updatedAt: now,
      },
    ];
    localStorage.setItem(mockKey, JSON.stringify(seed));
    return seed;
  }, []);

  const loadReal = useCallback(async (): Promise<RecordData[]> => {
    const p = vaultRef.current;
    if (!p) return [];
    // 原生核心插件：宿主进程内 FFI 批量读取（避免逐文件 IPC）
    const list = (await pluginCall(p, "core-records", "records.list", {})) as RecordData[];
    return list;
  }, []);

  const sortRecords = useCallback((arr: RecordData[]) => {
    return [...arr].sort((a, b) =>
      a.date === b.date
        ? a.createdAt < b.createdAt
          ? 1
          : -1
        : a.date < b.date
          ? 1
          : -1
    );
  }, []);

  const refresh = useCallback(async () => {
    if (isMock) {
      setRecords(sortRecords(mockLoad()));
      return;
    }
    setLoading(true);
    try {
      setRecords(sortRecords(await loadReal()));
    } catch (e) {
      console.error("[records] 刷新失败", e);
    } finally {
      setLoading(false);
    }
  }, [isMock, mockLoad, sortRecords, loadReal]);

  const persist = useCallback(
    async (record: RecordData): Promise<RecordData | null> => {
      if (isMock) {
        const all = mockLoad();
        const idx = all.findIndex((r) => r.id === record.id);
        if (idx >= 0) all[idx] = record;
        else all.push(record);
        localStorage.setItem(mockKey, JSON.stringify(all));
        return record;
      }
      const p = vaultRef.current;
      if (!p) return null;
      // 插件统一刷新 updatedAt，返回更新后的记录
      return (await pluginCall(p, "core-records", "records.save", {
        record,
      })) as RecordData;
    },
    [isMock, mockLoad]
  );

  const save = useCallback(
    async (record: RecordData) => {
      const updated = { ...record, updatedAt: new Date().toISOString() };
      try {
        const saved = await persist(updated);
        if (saved) {
          // 基于最新快照同步更新（反链由 useMemo 从 records 派生，无需手工维护）
          setRecords((prev) =>
            sortRecords(prev.map((r) => (r.id === saved.id ? saved : r)))
          );
        }
      } catch (e) {
        console.error("[records] 保存失败", e);
      }
    },
    [persist, sortRecords]
  );

  const create = useCallback(
    async (partial?: Partial<RecordData>): Promise<RecordData | null> => {
      if (isMock) {
        const now = new Date().toISOString();
        const record: RecordData = {
          id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          title: partial?.title?.trim() || "未命名记录",
          date: partial?.date || now.slice(0, 10),
          tags: partial?.tags ?? [],
          content: partial?.content ?? "",
          createdAt: now,
          updatedAt: now,
        };
        await persist(record);
        await refresh();
        return record;
      }
      const p = vaultRef.current;
      if (!p) return null;
      const r = (await pluginCall(p, "core-records", "records.create", {
        partial: partial ?? {},
      })) as RecordData;
      await refresh();
      return r;
    },
    [isMock, persist, refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      if (isMock) {
        localStorage.setItem(
          mockKey,
          JSON.stringify(mockLoad().filter((r) => r.id !== id))
        );
      } else {
        const p = vaultRef.current;
        if (p) {
          try {
            await pluginCall(p, "core-records", "records.delete", { id });
          } catch (e) {
            console.error(`[records] 删除失败 ${id}`, e);
          }
        }
      }
      await refresh();
    },
    [isMock, mockLoad, refresh]
  );

  const extractLinks = useCallback((content: string): string[] => {
    const out: string[] = [];
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const t = m[1].trim();
      if (t) out.push(t);
    }
    return out;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, vault.path]);

  /* 原生插件写操作（create/save/delete）后推送 records-changed，
     本层监听刷新，保证多窗口/浮窗外的数据一致 */
  useEffect(() => {
    let un: (() => void) | null = null;
    import("@tauri-apps/api/event")
      .then((m) =>
        m.listen<{ pluginId: string; event: string }>("plugin-event", (e) => {
          const payload = e.payload;
          if (payload.pluginId === "core-records" && payload.event === "records-changed") {
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

  const value: RecordsContextValue = useMemo(
    () => ({
      records,
      loading,
      refresh,
      create,
      save,
      remove,
      backlinks,
      extractLinks,
    }),
    [records, loading, refresh, create, save, remove, backlinks, extractLinks]
  );

  return (
    <RecordsContext.Provider value={value}>{children}</RecordsContext.Provider>
  );
}

/** 反链索引：笔记路径 → 引用它的记录（纯函数，由 records 派生） */
export function buildIndex(
  arr: RecordData[]
): Map<string, { recordId: string; title: string }[]> {
  const map = new Map<string, { recordId: string; title: string }[]>();
  for (const r of arr) {
    for (const link of extractLinksFrom(r.content)) {
      const key = link.replace(/^\/+/, "");
      const list = map.get(key) ?? [];
      list.push({ recordId: r.id, title: r.title });
      map.set(key, list);
    }
  }
  return map;
}

/** [[笔记]] 链接提取（供 buildIndex 与外部使用） */
function extractLinksFrom(content: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}
