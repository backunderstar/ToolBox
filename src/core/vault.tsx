import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  fsCreate,
  fsDelete,
  fsList,
  fsRead,
  fsRename,
  fsSearch,
  fsWrite,
  vaultGet,
  vaultSet,
} from "./api";
import type { FileEntry, SearchHit } from "./api";

const RECENT_KEY = "toolbox.recent";
const AUTOSAVE_DELAY = 800;
const SEARCH_DELAY = 300;

interface VaultContextValue {
  path: string | null;
  files: FileEntry[];
  activePath: string | null;
  content: string;
  dirty: boolean;
  recent: string[];
  query: string;
  results: SearchHit[] | null;
  searching: boolean;
  status: string;
  pickVault: () => Promise<void>;
  refresh: (vaultPath?: string) => Promise<void>;
  openFile: (rel: string) => Promise<void>;
  save: (manual?: boolean) => Promise<void>;
  newNote: () => Promise<void>;
  removeFile: (rel: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  setQuery: (q: string) => void;
  updateContent: (text: string) => void;
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault 必须在 VaultProvider 内使用");
  return ctx;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState("就绪");

  /* 最新状态引用：供保存/切换等回调读取，避免闭包过期 */
  const stateRef = useRef({ path, activePath, content });
  stateRef.current = { path, activePath, content };
  const dirtyRef = useRef(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => setStatus(msg), []);

  const refresh = useCallback(async (vaultPath?: string) => {
    const p = vaultPath ?? stateRef.current.path;
    if (!p) return;
    try {
      const list = await fsList(p);
      setFiles(list);
    } catch (e) {
      flash(String(e));
    }
  }, [flash]);

  const save = useCallback(
    async (manual = false) => {
      const { path: p, activePath: ap, content: c } = stateRef.current;
      if (!p || !ap) return;
      try {
        await fsWrite(p, ap, c);
        dirtyRef.current = false;
        setDirty(false);
        if (manual) flash(`已保存 ${ap}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [flash]
  );

  const addRecent = useCallback((rel: string) => {
    setRecent((prev) => {
      const next = [rel, ...prev.filter((r) => r !== rel)].slice(0, 10);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const openFile = useCallback(
    async (rel: string) => {
      const p = stateRef.current.path;
      if (!p) return;
      if (dirtyRef.current) await save(false);
      try {
        const text = await fsRead(p, rel);
        setActivePath(rel);
        setContent(text);
        dirtyRef.current = false;
        setDirty(false);
        addRecent(rel);
      } catch (e) {
        flash(String(e));
      }
    },
    [save, addRecent, flash]
  );

  const pickVault = useCallback(async () => {
    try {
      const sel = (await open({
        directory: true,
        title: "选择工作区文件夹",
      })) as string | null;
      if (!sel) return;
      await vaultSet(sel);
      setPath(sel);
      setActivePath(null);
      setContent("");
      dirtyRef.current = false;
      setDirty(false);
      await refresh(sel);
      flash("工作区已切换");
    } catch (e) {
      flash(String(e));
    }
  }, [refresh, flash]);

  const newNote = useCallback(async () => {
    const p = stateRef.current.path;
    if (!p) return;
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 14);
    const rel = `笔记-${ts}.md`;
    try {
      await fsCreate(p, rel);
      await refresh(p);
      await openFile(rel);
    } catch (e) {
      flash(String(e));
    }
  }, [refresh, openFile, flash]);

  const removeFile = useCallback(
    async (rel: string) => {
      const p = stateRef.current.path;
      if (!p) return;
      try {
        await fsDelete(p, rel);
        await refresh(p);
        if (stateRef.current.activePath === rel) {
          setActivePath(null);
          setContent("");
          dirtyRef.current = false;
          setDirty(false);
        }
        flash(`已删除 ${rel}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [refresh, flash]
  );

  const renameFile = useCallback(
    async (from: string, to: string) => {
      const p = stateRef.current.path;
      if (!p || from === to) return;
      try {
        await fsRename(p, from, to);
        await refresh(p);
        if (stateRef.current.activePath === from) setActivePath(to);
        flash(`已重命名 ${from} → ${to}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [refresh, flash]
  );

  const updateContent = useCallback(
    (text: string) => {
      setContent(text);
      dirtyRef.current = true;
      setDirty(true);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save(false), AUTOSAVE_DELAY);
    },
    [save]
  );

  /* 启动：读取已保存的工作区 + 最近打开 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await vaultGet();
        if (!alive || !s.path) return;
        setPath(s.path);
        await refresh(s.path);
      } catch (e) {
        flash(String(e));
      }
    })();
    const saved = localStorage.getItem(RECENT_KEY);
    if (saved) {
      try {
        setRecent(JSON.parse(saved) as string[]);
      } catch {
        /* 忽略损坏数据 */
      }
    }
    return () => {
      alive = false;
    };
  }, [refresh, flash]);

  /* 搜索：防抖调用 Rust 全文搜索 */
  useEffect(() => {
    if (!path || !query.trim()) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await fsSearch(path, query);
        setResults(r);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DELAY);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, path]);

  const value: VaultContextValue = {
    path,
    files,
    activePath,
    content,
    dirty,
    recent,
    query,
    results,
    searching,
    status,
    pickVault,
    refresh,
    openFile,
    save,
    newNote,
    removeFile,
    renameFile,
    setQuery,
    updateContent,
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}
