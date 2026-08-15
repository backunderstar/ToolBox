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
 * 工作记录数据层（M4）：data/records/<id>.json
 *
 * - 一条记录一个 JSON 文件；date 按天分组，tags 用于筛选统计
 * - content 支持 [[笔记路径]] 语法，与笔记双向链接
 * - 自动保存（防抖）
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

const DIR = "data/records";

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
    const list: FileEntry[] = await fsListDir(p, DIR);
    const files = list.filter((f) => !f.isDir && f.path.endsWith(".json"));
    const out: RecordData[] = [];
    for (const f of files) {
      try {
        const raw = await fsRead(p, f.path);
        out.push(JSON.parse(raw) as RecordData);
      } catch (e) {
        console.error(`[records] 读取失败 ${f.path}`, e);
      }
    }
    return out;
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
    async (record: RecordData) => {
      if (isMock) {
        const all = mockLoad();
        const idx = all.findIndex((r) => r.id === record.id);
        if (idx >= 0) all[idx] = record;
        else all.push(record);
        localStorage.setItem(mockKey, JSON.stringify(all));
        return;
      }
      const p = vaultRef.current;
      if (!p) return;
      await fsWrite(p, `${DIR}/${record.id}.json`, JSON.stringify(record, null, 2));
    },
    [isMock, mockLoad]
  );

  const save = useCallback(
    async (record: RecordData) => {
      const updated = { ...record, updatedAt: new Date().toISOString() };
      try {
        await persist(updated);
        // 基于最新快照同步更新（反链由 useMemo 从 records 派生，无需手工维护）
        setRecords((prev) => sortRecords(prev.map((r) => (r.id === updated.id ? updated : r))));
      } catch (e) {
        console.error("[records] 保存失败", e);
      }
    },
    [persist, sortRecords]
  );

  const create = useCallback(
    async (partial?: Partial<RecordData>): Promise<RecordData | null> => {
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
    },
    [persist, refresh]
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
            await fsDelete(p, `${DIR}/${id}.json`);
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

  const value: RecordsContextValue = {
    records,
    loading,
    refresh,
    create,
    save,
    remove,
    backlinks,
    extractLinks,
  };

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
