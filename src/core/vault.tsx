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

const AUTOSAVE_DELAY = 800;
const SEARCH_DELAY = 300;

interface VaultContextValue {
  path: string | null;
  files: FileEntry[];
  activePath: string | null;
  content: string;
  dirty: boolean;
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
  // 调试模式：?mock=1 时在浏览器（无 Tauri）中也能渲染笔记界面
  const isMock = useMemo(
    () => new URLSearchParams(window.location.search).has("mock"),
    []
  );
  const isMockRef = useRef(isMock);
  isMockRef.current = isMock;

  const [path, setPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
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
      if (isMockRef.current) {
        dirtyRef.current = false;
        setDirty(false);
        return;
      }
      const { path: p, activePath: ap, content: c } = stateRef.current;
      if (!p || !ap) return;
      try {
        await fsWrite(p, ap, c);
        // 写盘期间若有新输入（content 已变化），不清 dirty，交给新定时器保存
        const { content: latest } = stateRef.current;
        if (latest === c) {
          dirtyRef.current = false;
          setDirty(false);
          if (manual) flash(`已保存 ${ap}`);
        } else if (manual) {
          flash("保存中检测到新输入，稍后自动保存");
        }
      } catch (e) {
        flash(String(e));
      }
    },
    [flash]
  );

  const openFile = useCallback(
    async (rel: string) => {
      if (isMockRef.current) return;
      const p = stateRef.current.path;
      if (!p) return;
      if (dirtyRef.current) await save(false);
      try {
        const text = await fsRead(p, rel);
        setActivePath(rel);
        setContent(text);
        dirtyRef.current = false;
        setDirty(false);
      } catch (e) {
        flash(String(e));
      }
    },
    [save, flash]
  );

  const pickVault = useCallback(async () => {
    if (isMockRef.current) return;
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
    if (isMockRef.current) return;
    const p = stateRef.current.path;
    if (!p) return;
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 14);
    // 笔记统一存放在工作区 notes/ 目录下
    const rel = `notes/笔记-${ts}.md`;
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
      if (isMockRef.current) return;
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
      if (isMockRef.current) return;
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

  /* 启动：读取已保存的工作区（mock 模式则用内置示例） */
  useEffect(() => {
    if (isMock) {
      setPath("mock-vault");
      setFiles([{ name: "示例笔记.md", path: "notes/示例笔记.md", isDir: false }]);
      setActivePath("notes/示例笔记.md");
      setContent(
        "# 示例笔记\n\n欢迎使用 ToolBox。\n\n- 列表一\n- 列表二\n\n```js\nconsole.log(1)\n```\n\n> 引用内容\n\n**加粗** 与 $E=mc^2$"
      );
      return;
    }
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
    return () => {
      alive = false;
    };
  }, [refresh, flash, isMock]);

  /* 搜索：防抖调用 Rust 全文搜索；请求序号丢弃过期响应（快速输入时旧结果不覆盖新结果） */
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!path || !query.trim()) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await fsSearch(path, query);
        if (seq !== searchSeq.current) return; // 过期响应
        setResults(r);
      } catch {
        if (seq !== searchSeq.current) return;
        setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, SEARCH_DELAY);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, path]);

  const value = useMemo<VaultContextValue>(
    () => ({
      path,
      files,
      activePath,
      content,
      dirty,
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
    }),
    [
      path,
      files,
      activePath,
      content,
      dirty,
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
    ]
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}
