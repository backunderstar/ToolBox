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
  fsWrite,
  searchAll,
  vaultGet,
  vaultSet,
} from "./api";
import type { FileEntry, SearchHit } from "./api";

/**
 * 工作区（Vault）状态中心（M1，宿主侧唯一数据源）：
 *
 * - 职责：工作区路径 / 文件树 / 当前笔记（activePath+content）/ 脏标记 /
 *   全局全文搜索（顶栏搜索）/ 操作反馈状态条（status）。
 * - 文件操作（列表/读写/增删改）经 core-notes 原生插件（plugin_call → DLL）；
 *   全局搜索经宿主 search_all（FTS + 搜索提供者聚合）。
 * - **状态流要点**（读代码前先理解这三个，其余都是衍生）：
 *   1. `stateRef`：所有异步回调（save/openFile/pickVault）读"最新状态"都经它，
 *      避免闭包捕获过期值——组件内 useCallback 闭包只捕获首次渲染的 state。
 *   2. 自动保存：updateContent 置脏 + 800ms 防抖定时器（AUTOSAVE_DELAY）；
 *      save 写盘后对比"写盘时快照"与"最新 content"，有新增输入则不撤脏，
 *      交给下一轮定时器（防抖窗口内连续输入不丢）。
 *   3. 竞态防护：openFile 读盘期间用户继续输入 → 放弃切换（不覆盖新输入）；
 *      搜索用请求序号（searchSeq）丢弃过期响应。
 * - 笔记视图已迁到 core-notes 插件自带前端（PluginUiView）：插件侧通过
 *   `tb:vault-active` 事件同步"当前打开的笔记"回本层（宿主不持有插件 UI
 *   内部状态），AI 预设等插件经 context.activePath/activeContent 读取；
 *   插件写文件后推 `notes-changed` 事件，本层监听刷新文件树。
 */

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
  const isMock = useMemo(() => new URLSearchParams(window.location.search).has("mock"), []);
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
  const stateRef = useRef({ path, activePath, content, files });
  stateRef.current = { path, activePath, content, files };
  const dirtyRef = useRef(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => setStatus(msg), []);

  const refresh = useCallback(
    async (vaultPath?: string) => {
      const p = vaultPath ?? stateRef.current.path;
      if (!p) return;
      try {
        const list = await fsList(p);
        setFiles(list);
      } catch (e) {
        flash(String(e));
      }
    },
    [flash],
  );

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
    [flash],
  );

  const openFile = useCallback(
    async (rel: string) => {
      if (isMockRef.current) return;
      const p = stateRef.current.path;
      if (!p) return;
      if (dirtyRef.current) await save(false);
      // 快照打开前的内容：fsRead 是异步 IPC，若期间用户继续输入，
      // 直接 setContent 会用旧内容覆盖新输入 → 静默丢字
      const openingContent = stateRef.current.content;
      try {
        const text = await fsRead(p, rel);
        if (stateRef.current.content !== openingContent) {
          flash("读取期间有新的输入，已取消切换");
          return;
        }
        setActivePath(rel);
        setContent(text);
        dirtyRef.current = false;
        setDirty(false);
      } catch (e) {
        flash(String(e));
      }
    },
    [save, flash],
  );

  const pickVault = useCallback(async () => {
    if (isMockRef.current) return;
    try {
      const sel = (await open({
        directory: true,
        title: "选择工作区文件夹",
        // 已设置工作区时，对话框初始定位到当前工作区目录（否则落在系统默认/记忆位置）
        defaultPath: stateRef.current.path ?? undefined,
      })) as string | null;
      if (!sel) return;
      // 切换前把未保存内容落盘（写入旧工作区），防止防抖窗口内的输入丢失
      if (dirtyRef.current) await save(false);
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
  }, [refresh, flash, save]);

  const newNote = useCallback(async () => {
    if (isMockRef.current) return;
    const p = stateRef.current.path;
    if (!p) return;
    // 时间戳到毫秒（17 位 YYYYMMDDHHmmssSSS）：秒级粒度连续新建会撞名
    // （fsCreate 冲突虽然被捕获并 flash，但体验差）
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 17);
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
    [refresh, flash],
  );

  const renameFile = useCallback(
    async (from: string, to: string) => {
      if (isMockRef.current) return;
      const p = stateRef.current.path;
      if (!p || from === to) return;
      // 前端校验（后端也会兜底）：非法字符 / 目标已存在
      const name = to.slice(to.lastIndexOf("/") + 1);
      if (/[\\/:*?"<>|]/.test(name)) {
        flash(`文件名包含非法字符: ${name}`);
        return;
      }
      if (stateRef.current.files.some((f) => f.path === to && f.path !== from)) {
        flash(`同名文件已存在: ${to}`);
        return;
      }
      try {
        await fsRename(p, from, to);
        await refresh(p);
        if (stateRef.current.activePath === from) setActivePath(to);
        flash(`已重命名 ${from} → ${to}`);
      } catch (e) {
        flash(String(e));
      }
    },
    [refresh, flash],
  );

  const updateContent = useCallback(
    (text: string) => {
      setContent(text);
      dirtyRef.current = true;
      setDirty(true);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save(false), AUTOSAVE_DELAY);
    },
    [save],
  );

  /* 启动：读取已保存的工作区（mock 模式则用内置示例） */
  useEffect(() => {
    if (isMock) {
      setPath("mock-vault");
      setFiles([{ name: "示例笔记.md", path: "notes/示例笔记.md", isDir: false, size: null }]);
      setActivePath("notes/示例笔记.md");
      setContent(
        "# 示例笔记\n\n欢迎使用 ToolBox。\n\n- 列表一\n- 列表二\n\n```js\nconsole.log(1)\n```\n\n> 引用内容\n\n**加粗** 与 $E=mc^2$",
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
      // 先递增序号使在途请求失效，再清空结果：否则已发出的 searchAll 响应仍会
      // 通过 seq 校验，把旧结果回填到已清空的搜索框下方。
      searchSeq.current++;
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await searchAll(path, query);
        if (seq !== searchSeq.current) return; // 过期响应
        setResults(r);
      } catch (e) {
        if (seq !== searchSeq.current) return;
        // 失败要明确提示：静默清空会让用户误以为"没有结果"（其余 invoke
        // 失败都有 flash，唯独此处此前例外）
        flash(`搜索失败: ${e}`);
        setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, SEARCH_DELAY);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, path]);

  /* 插件自带前端（core-notes ui）写文件后推送 notes-changed：
     本层监听刷新文件列表，保证顶栏/状态栏/其他视图读到一致的文件树 */
  useEffect(() => {
    let un: (() => void) | null = null;
    // 竞态防护（与 pluginRuntime api.on 同型）：动态 import + listen 都是异步
    // promise，Provider 卸载可能发生在 resolve 之前；cancelled 标志保证 resolve
    // 后立即注销，避免监听器泄漏。
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then((m) =>
        m.listen<{ pluginId: string; event: string }>("plugin-event", (e) => {
          if (cancelled) return;
          const payload = e.payload;
          if (payload.pluginId === "core-notes" && payload.event === "notes-changed") {
            void refresh();
          }
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else un = fn;
      })
      .catch(() => {
        /* 浏览器预览环境无事件桥 */
      });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [refresh]);

  /* 笔记视图为插件自带前端时，插件通过同 document 的 tb:vault-active 事件
     同步当前打开的笔记（宿主 vault 不持有插件 UI 内部状态），
     使 AI 预设动作等读取 context.activePath/activeContent 的插件拿到最新上下文 */
  useEffect(() => {
    const onActive = (e: Event) => {
      const detail = (e as CustomEvent<{ rel?: string; content?: string }>).detail;
      if (typeof detail?.rel === "string" && detail.rel) {
        setActivePath(detail.rel);
        if (typeof detail.content === "string") {
          setContent(detail.content);
        }
        dirtyRef.current = false;
        setDirty(false);
      }
    };
    window.addEventListener("tb:vault-active", onActive);
    return () => window.removeEventListener("tb:vault-active", onActive);
  }, []);

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
    ],
  );

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}
