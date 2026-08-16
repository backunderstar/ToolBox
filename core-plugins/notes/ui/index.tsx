// core-notes 插件自带前端（组件模式）：文件树 + Vditor 编辑器 + 反链 + 全文搜索。
// 数据全部经统一 api 桥：本插件命令（notes.*）+ 宿主内嵌搜索（api.host.search）/
// 跨插件（core-checklists 反链 / core-ai 摘要）。宿主全局 CSS 生效，
// 仅新增少量样式在 style.css（Vite 提取，宿主注入）。
// Vditor 依赖宿主同源 /vditor 静态资源（与宿主回退组件共享，离线可用）。
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Vditor from "vditor";
import "vditor/dist/index.css";
import "./style.css";

/** 宿主注入的桥 API（PluginUiView 构造） */
interface PluginBridgeApi {
  pluginId: string;
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  context: { vault: string | null } & Record<string, unknown>;
  nav?: {
    go: (view: string) => void;
    openNote: (rel: string) => void;
    openChecklist: (id: string) => void;
  };
  /** 宿主能力（搜索迁回本体后经此调用，含搜索提供者聚合） */
  host?: { search: (query: string) => Promise<SearchHit[]> };
}

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

interface SearchHit {
  path: string;
  filename: string;
  snippet: string;
  source?: string;
}

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  note?: string;
}
interface Checklist {
  id: string;
  title: string;
  items: ChecklistItem[];
}

const AUTOSAVE = 800;
const SEARCH_DELAY = 300;

/* ---------------- 内联小图标（插件独立构建，不共享宿主 icons） ---------------- */

const svg = (children: React.ReactNode, size = 14, sw = 1.6) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
const IconFileText = () =>
  svg(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>,
    14,
  );
const IconFolder = () =>
  svg(<path d="M3.5 6.5h6l2 2.5h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />, 14);
const IconChevronRight = () => svg(<path d="M9 6l6 6-6 6" />, 12);
const IconChevronLeft = () => svg(<path d="M15 6l-6 6 6 6" />, 14);
const IconChevronDown = () => svg(<path d="M6 9l6 6 6-6" />, 12);
const IconPlus = () => svg(<path d="M12 5v14M5 12h14" />, 14);
const IconTrash = () =>
  svg(
    <>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12" />
      <path d="M10 11v6M14 11v6" />
    </>,
    12,
  );
const IconExpand = () => svg(<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />, 14);
const IconShrink = () => svg(<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />, 14);
const IconLink = () =>
  svg(
    <>
      <path d="M9.5 14.5l5-5" />
      <path d="M8 12.5L5.5 15a3.5 3.5 0 0 0 5 5L13 17.5" />
      <path d="M16 11.5l2.5-2.5a3.5 3.5 0 0 0-5-5L11 6.5" />
    </>,
    12,
  );

/* ---------------- 主组件 ---------------- */
export function NotesPluginUi({ api }: { api: PluginBridgeApi }) {
  const vault = api.context.vault;
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  // 状态消息条：flash() 写入，4s 后自动清除；err=true 渲染为错误样式（编辑器底部 .editor-status）
  const [status, setStatus] = useState("");
  const [statusErr, setStatusErr] = useState(false);
  /* 布局偏好：文件面板折叠 / 专注模式（localStorage 持久化，宿主布局互不影响） */
  const [filesCollapsed, setFilesCollapsed] = useState(() =>
    loadPref("notes.filesCollapsed", false),
  );
  const [focusMode, setFocusMode] = useState(() => loadPref("notes.focusMode", false));
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark");

  /* 最新状态引用：供保存/切换等回调读取，避免闭包过期 */
  const stateRef = useRef({ activePath, content, files });
  stateRef.current = { activePath, content, files };
  const dirtyRef = useRef(false);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 状态条消息：新消息重置 4s 清除计时（连发时以最后一条为准） */
  const flash = (msg: string, err = false) => {
    setStatus(msg);
    setStatusErr(err);
    if (statusTimer.current) clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(""), 4000);
  };

  /* 主题跟随：宿主切换主题时更新（Vditor setTheme + 暗色变量由宿主 tokens 自动生效） */
  useEffect(() => {
    const mo = new MutationObserver(() =>
      setDark(document.documentElement.dataset.theme === "dark"),
    );
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  /* 卸载时清理状态条计时器 */
  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    [],
  );

  useEffect(() => savePref("notes.filesCollapsed", filesCollapsed), [filesCollapsed]);
  useEffect(() => savePref("notes.focusMode", focusMode), [focusMode]);

  const refresh = async () => {
    if (!vaultRef.current) return;
    try {
      setFiles((await api.call("notes.list")) as FileEntry[]);
    } catch (e) {
      flash(String(e), true);
    }
  };

  const save = async (manual = false) => {
    const { activePath: ap, content: c } = stateRef.current;
    if (!vaultRef.current || !ap) return;
    try {
      await api.call("notes.write", { rel: ap, content: c });
      const latest = stateRef.current.content;
      if (latest === c) {
        dirtyRef.current = false;
        setDirty(false);
        if (manual) flash(`已保存 ${ap}`);
      } else if (manual) {
        flash("保存中检测到新输入，稍后自动保存");
      }
    } catch (e) {
      flash(String(e), true);
    }
  };

  const openFile = async (rel: string) => {
    const v = vaultRef.current;
    if (!v) return;
    if (dirtyRef.current) await save(false);
    // 快照打开前的内容：fsRead 是异步 IPC，若期间用户继续输入，
    // 直接 setContent 会用旧内容覆盖新输入 → 静默丢字
    const before = stateRef.current.content;
    try {
      const text = (await api.call("notes.read", { rel })) as string;
      if (stateRef.current.content !== before) {
        flash("读取期间有新的输入，已取消切换");
        return;
      }
      setActivePath(rel);
      setContent(text);
      dirtyRef.current = false;
      setDirty(false);
      // 同步宿主 vault（tb:vault-active）：AI 预设等插件界面经 context 读取当前笔记
      window.dispatchEvent(new CustomEvent("tb:vault-active", { detail: { rel, content: text } }));
    } catch (e) {
      flash(String(e), true);
    }
  };

  const newNote = async () => {
    const v = vaultRef.current;
    if (!v) return;
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const rel = `notes/笔记-${ts}.md`;
    try {
      await api.call("notes.create", { rel });
      await refresh();
      await openFile(rel);
    } catch (e) {
      flash(String(e), true);
    }
  };

  const removeFile = async (rel: string) => {
    const v = vaultRef.current;
    if (!v) return;
    try {
      await api.call("notes.delete", { rel });
      await refresh();
      if (stateRef.current.activePath === rel) {
        setActivePath(null);
        setContent("");
        dirtyRef.current = false;
        setDirty(false);
      }
      flash(`已删除 ${rel}`);
    } catch (e) {
      flash(String(e), true);
    }
  };

  const renameFile = async (from: string, to: string) => {
    const v = vaultRef.current;
    if (!v || from === to) return;
    // 前端校验（后端也会兜底）：非法字符 / 目标已存在
    const name = to.slice(to.lastIndexOf("/") + 1);
    if (/[\\/:*?"<>|]/.test(name)) {
      flash(`文件名包含非法字符: ${name}`, true);
      return;
    }
    if (stateRef.current.files.some((f) => f.path === to && f.path !== from)) {
      flash(`同名文件已存在: ${to}`, true);
      return;
    }
    try {
      await api.call("notes.rename", { from, to });
      await refresh();
      if (stateRef.current.activePath === from) setActivePath(to);
      flash(`已重命名 ${from} → ${to}`);
    } catch (e) {
      flash(String(e), true);
    }
  };

  const updateContent = (text: string) => {
    setContent(text);
    dirtyRef.current = true;
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void save(false), AUTOSAVE);
  };

  /* 卸载兜底：自动保存定时器未触发时把草稿落盘 */
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (dirtyRef.current) void save(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 启动：加载文件列表 */
  useEffect(() => {
    if (!vaultRef.current) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 挂载时打开目标笔记：优先其他视图经 tb:open-note 广播的待打开笔记，
     否则回退宿主 context 快照（双向链接/跨视图跳转进入本视图的场景） */
  useEffect(() => {
    if (!vaultRef.current) return;
    const w = window as unknown as Record<string, unknown>;
    const pending =
      typeof w.__TB_PENDING_NOTE__ === "string" ? (w.__TB_PENDING_NOTE__ as string) : null;
    if (pending) {
      w.__TB_PENDING_NOTE__ = null;
      void openFile(pending);
    } else if (typeof api.context.activePath === "string" && api.context.activePath) {
      void openFile(api.context.activePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* tb:open-note 事件（安全网：本视图已挂载时其他界面打开笔记） */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const rel = (e as CustomEvent<string>).detail;
      if (typeof rel === "string" && rel) void openFile(rel);
    };
    window.addEventListener("tb:open-note", onOpen);
    return () => window.removeEventListener("tb:open-note", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* notes-changed：其他窗口/插件 UI 写文件后刷新文件列表 */
  useEffect(() => {
    const un = api.on("notes-changed", () => void refresh());
    return un;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 全文搜索：防抖 + 序号丢弃过期响应（宿主内嵌搜索，经统一桥 host.search） */
  useEffect(() => {
    if (!vaultRef.current || !query.trim()) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(async () => {
      try {
        const r = api.host ? await api.host.search(query) : [];
        if (seq !== searchSeq.current) return;
        setResults(r);
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, SEARCH_DELAY);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  /* 反链索引：跨插件取清单数据，按笔记路径建索引（记录功能已删除） */
  const [backlinks, setBacklinks] = useState<
    Map<string, { type: "清单"; id: string; title: string }[]>
  >(new Map());
  useEffect(() => {
    let alive = true;
    (async () => {
      const map = new Map<string, { type: "清单"; id: string; title: string }[]>();
      const push = (key: string, entry: { type: "清单"; id: string; title: string }) => {
        const k = key.replace(/^\/+/, "");
        if (!k) return;
        const list = map.get(k) ?? [];
        list.push(entry);
        map.set(k, list);
      };
      try {
        const chks = (await api.call("chk.list", {}, "core-checklists")) as Checklist[];
        for (const c of chks)
          for (const it of c.items)
            if (it.note) push(it.note, { type: "清单", id: c.id, title: c.title });
      } catch {
        /* 清单插件不可用则跳过 */
      }
      if (alive) setBacklinks(map);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const vaultName = vault ? (vault.split(/[\\/]/).pop() ?? vault) : null;

  /* 无工作区：引导（选工作区按钮在宿主顶栏） */
  if (!vault) {
    return (
      <div className="empty-state fade-in">
        <div className="empty-icon">
          <IconFolder />
        </div>
        <h2>选择工作区文件夹</h2>
        <p>
          笔记以普通 Markdown 文件存放在你指定的文件夹中，
          数据始终是你的，随时可迁移、可备份。请在顶栏点击工作区按钮选择。
        </p>
      </div>
    );
  }

  const showingSearch = query.trim().length > 0;

  return (
    <div className="notes">
      {/* 文件侧栏（专注模式或折叠时隐藏/收窄） */}
      {!focusMode &&
        (filesCollapsed ? (
          <aside className="files-pane collapsed">
            <button
              className="files-expand"
              onClick={() => setFilesCollapsed(false)}
              title="展开文件面板"
            >
              <IconChevronRight />
            </button>
          </aside>
        ) : (
          <aside className="files-pane">
            <div className="files-header">
              <span className="files-title" title={vault}>
                {vaultName}
              </span>
              <button
                className="icon-btn sm"
                title="新建笔记"
                aria-label="新建笔记"
                onClick={() => void newNote()}
              >
                <IconPlus />
              </button>
              <button
                className="icon-btn sm"
                title="收起文件面板"
                aria-label="收起文件面板"
                onClick={() => setFilesCollapsed(true)}
              >
                <IconChevronLeft />
              </button>
            </div>
            {/* 插件自带搜索框（顶栏搜索在插件模式下停用） */}
            <div className="files-search">
              <input
                className="files-search-input"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索笔记（文件名 + 内容）…"
                spellCheck={false}
              />
            </div>
            <FileTree
              files={files}
              activePath={activePath}
              onOpen={(rel) => void openFile(rel)}
              onRemove={(rel) => void removeFile(rel)}
              onRename={(from, to) => void renameFile(from, to)}
            />
          </aside>
        ))}

      {/* 编辑器区域 */}
      <div className="editor-area">
        {showingSearch ? (
          <SearchResults
            searching={searching}
            results={results}
            query={query}
            onOpen={async (hit) => {
              await openFile(hit.path);
              setQuery("");
            }}
          />
        ) : activePath ? (
          <>
            <div className="editor-header">
              <span
                className={`dirty-dot${dirty ? " on" : ""}`}
                title={dirty ? "有未保存修改" : "已保存"}
              />
              <span className="editor-title" title={activePath}>
                {activePath}
              </span>
              <div className="spacer" />
              <button
                className="icon-btn sm"
                onClick={() => setFocusMode((f) => !f)}
                title={focusMode ? "退出专注模式" : "专注模式（隐藏侧栏，全屏书写）"}
                aria-label={focusMode ? "退出专注模式" : "专注模式"}
              >
                {focusMode ? <IconShrink /> : <IconExpand />}
              </button>
              <button className="btn-ghost sm" onClick={() => void save(true)}>
                {dirty ? "保存" : "已保存"}
              </button>
            </div>
            <BacklinksPanel activePath={activePath} backlinks={backlinks} nav={api.nav} />
            <div className="editor-body">
              <NoteEditor
                key={activePath}
                api={api}
                doc={content}
                onChange={updateContent}
                onSave={() => void save(true)}
                dark={dark}
                placeholderText="开始书写…"
              />
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <IconFileText />
            </div>
            <h2>从一篇笔记开始</h2>
            <p>在左侧选择一篇笔记，或新建一篇。</p>
            <button className="btn-primary" onClick={() => void newNote()}>
              新建笔记
            </button>
          </div>
        )}
      </div>

      {/* 状态条：保存/删除/重命名等操作反馈与错误提示（flash 消息，4s 自动清除） */}
      <div className={`editor-status${statusErr ? " error" : ""}`} role="status" aria-live="polite">
        {status}
      </div>
    </div>
  );
}

/* ---------------- 文件树（迁移自宿主 FileTree） ---------------- */

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

/** 扁平列表（目录优先、父先于子）→ 树 */
function buildTree(entries: FileEntry[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const e of entries) {
    const node: TreeNode = { name: e.name, path: e.path, isDir: e.isDir, children: [] };
    map.set(e.path, node);
    const parts = e.path.split("/");
    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parent = map.get(parts.slice(0, -1).join("/"));
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh") : a.isDir ? -1 : 1,
    );
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const parentOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

function FileTree({
  files,
  activePath,
  onOpen,
  onRemove,
  onRename,
}: {
  files: FileEntry[];
  activePath: string | null;
  onOpen: (rel: string) => void;
  onRemove: (rel: string) => void;
  onRename: (from: string, to: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(files.filter((f) => f.isDir).map((f) => f.path)),
  );

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /* 扁平可见行（展开的目录含子级）——供键盘上下移动焦点 */
  const visiblePaths = useMemo(() => {
    const out: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        out.push(n.path);
        if (n.isDir && expanded.has(n.path)) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree, expanded]);

  /** 按 path 聚焦某一行（键盘导航用） */
  const focusRow = (path: string) => {
    const el = document.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(path)}"]`);
    el?.focus();
  };

  if (tree.length === 0) {
    return (
      <div className="tree-empty">
        <p>还没有笔记</p>
        <p className="tree-empty-hint">点击上方「新建笔记」开始</p>
      </div>
    );
  }

  return (
    <div className="file-tree" role="tree">
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          activePath={activePath}
          onOpen={onOpen}
          onRemove={onRemove}
          onRename={onRename}
          visiblePaths={visiblePaths}
          focusRow={focusRow}
        />
      ))}
    </div>
  );
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  onToggle,
  activePath,
  onOpen,
  onRemove,
  onRename,
  visiblePaths,
  focusRow,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  activePath: string | null;
  onOpen: (rel: string) => void;
  onRemove: (rel: string) => void;
  onRename: (from: string, to: string) => void;
  visiblePaths: string[];
  focusRow: (path: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.name);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const isOpen = expanded.has(node.path);
  const isActive = node.path === activePath;
  const indent = { paddingLeft: `${8 + depth * 14}px` };

  const commitRename = () => {
    setEditing(false);
    let name = editValue.trim();
    if (!name || name === node.name) return;
    if (!name.endsWith(".md")) name += ".md";
    const parent = parentOf(node.path);
    const to = parent ? `${parent}/${name}` : name;
    onRename(node.path, to);
  };

  /* Enter/Escape 与 onBlur 叠加：blur 在输入框卸载后也会触发，
     用 ref 标记已处理，避免 Enter 后二次提交 / Escape 无法取消 */
  const handledRef = useRef(false);

  const commitOrCancel = (cancel: boolean) => {
    if (handledRef.current) return;
    handledRef.current = true;
    if (cancel) setEditing(false);
    else commitRename();
  };

  const askDelete = () => {
    if (confirming) {
      onRemove(node.path);
      return;
    }
    setConfirming(true);
    confirmTimer.current = setTimeout(() => setConfirming(false), 3000);
  };

  /* 键盘导航：↑↓ 在可见行间移动焦点；→ 展开 / ← 收起目录；Enter/Space 打开 */
  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const idx = visiblePaths.indexOf(node.path);
    if (e.key === "ArrowDown" && idx >= 0 && idx < visiblePaths.length - 1) {
      e.preventDefault();
      focusRow(visiblePaths[idx + 1]);
    } else if (e.key === "ArrowUp" && idx > 0) {
      e.preventDefault();
      focusRow(visiblePaths[idx - 1]);
    } else if (e.key === "ArrowRight" && node.isDir && !isOpen) {
      e.preventDefault();
      onToggle(node.path);
    } else if (e.key === "ArrowLeft" && node.isDir && isOpen) {
      e.preventDefault();
      onToggle(node.path);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (node.isDir) onToggle(node.path);
      else onOpen(node.path);
    }
  };

  return (
    <div>
      <div
        className={`tree-row${isActive ? " active" : ""}`}
        style={indent}
        role="treeitem"
        aria-selected={isActive}
        aria-expanded={node.isDir ? isOpen : undefined}
        tabIndex={0}
        data-path={node.path}
        onClick={() => (node.isDir ? onToggle(node.path) : onOpen(node.path))}
        onKeyDown={onRowKeyDown}
      >
        <span className="tree-chevron">
          {node.isDir ? isOpen ? <IconChevronDown /> : <IconChevronRight /> : null}
        </span>
        <span className="tree-icon">{node.isDir ? <IconFolder /> : <IconFileText />}</span>
        {editing ? (
          <input
            ref={inputRef}
            className="tree-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitOrCancel(false);
              if (e.key === "Escape") commitOrCancel(true);
            }}
            onBlur={() => commitOrCancel(handledRef.current)}
          />
        ) : (
          <span
            className="tree-name"
            title={node.path}
            onDoubleClick={(e) => {
              if (!node.isDir) {
                e.stopPropagation();
                handledRef.current = false;
                setEditValue(node.name);
                setEditing(true);
              }
            }}
          >
            {node.name}
          </span>
        )}
        {!node.isDir && !editing && (
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className={`tree-action${confirming ? " danger" : ""}`}
              title={confirming ? "再次点击确认删除" : "删除"}
              aria-label={confirming ? "确认删除" : `删除 ${node.name}`}
              onClick={askDelete}
            >
              {confirming ? "确认?" : <IconTrash />}
            </button>
          </span>
        )}
      </div>
      {node.isDir && isOpen && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              activePath={activePath}
              onOpen={onOpen}
              onRemove={onRemove}
              onRename={onRename}
              visiblePaths={visiblePaths}
              focusRow={focusRow}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- 反链面板（迁移自宿主 Backlinks，数据来自跨插件索引） ---------------- */

function BacklinksPanel({
  activePath,
  backlinks,
  nav,
}: {
  activePath: string;
  backlinks: Map<string, { type: "清单"; id: string; title: string }[]>;
  nav?: PluginBridgeApi["nav"];
}) {
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const base = activePath.replace(/^\/+/, "");
    const baseName = activePath.split("/").pop() ?? activePath;
    const out: { type: "清单"; title: string; id: string }[] = [];
    let exact = 0;
    for (const [path, entries] of backlinks) {
      if (path === base) {
        for (const e of entries) out.push({ type: e.type, title: e.title, id: e.id });
        exact += entries.length;
      }
    }
    if (exact === 0) {
      for (const [path, entries] of backlinks) {
        if (path.split("/").pop() === baseName) {
          for (const e of entries) out.push({ type: e.type, title: e.title, id: e.id });
        }
      }
    }
    return out;
  }, [activePath, backlinks]);

  useEffect(() => {
    setOpen(false);
  }, [activePath]);

  if (matches.length === 0) return null;

  return (
    <div className="backlinks">
      <button className="backlinks-toggle" onClick={() => setOpen((o) => !o)}>
        <IconLink />
        <span>反向链接 {matches.length}</span>
        <IconChevronDown className={`backlinks-caret${open ? " flip" : ""}`} />
      </button>
      {open && (
        <div className="backlinks-list">
          {matches.map((m, i) => (
            <button
              key={`${m.type}-${m.id}-${i}`}
              className="backlink-item"
              onClick={() => {
                if (!nav) return;
                nav.openChecklist(m.id);
              }}
            >
              <span className="backlink-type backlink-type-check">{m.type}</span>
              <span className="backlink-title">{m.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- 搜索结果（迁移自宿主 NotesView.SearchResults） ---------------- */

function SearchResults({
  searching,
  results,
  query,
  onOpen,
}: {
  searching: boolean;
  results: SearchHit[] | null;
  query: string;
  onOpen: (hit: SearchHit) => void;
}) {
  const count = results?.length ?? 0;
  return (
    <div className="search-results" aria-live="polite">
      <div className="search-results-header">
        <span>
          搜索「{query}」{searching ? "…" : ` · ${count} 个结果`}
        </span>
      </div>
      {searching ? (
        <div className="search-hint">检索中…</div>
      ) : count === 0 ? (
        <div className="search-hint">没有匹配的内容</div>
      ) : (
        <div className="search-list">
          {results!.map((hit) => (
            <button
              key={`${hit.source ?? "file"}:${hit.path}`}
              className="result-item"
              onClick={() => onOpen(hit)}
            >
              <div className="result-title">
                {hit.source && (
                  <span className="result-source" title="来自插件搜索提供者">
                    {SOURCE_LABEL[hit.source] ?? hit.source}
                  </span>
                )}
                {highlight(hit.path, query)}
              </div>
              <div className="result-snippet">{highlight(hit.snippet, query)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 搜索来源显示名（插件 id → 中文；当前无搜索提供者插件，保留空表供未来扩展） */
const SOURCE_LABEL: Record<string, string> = {};

/** 大小写不敏感的关键词高亮（安全转义正则） */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  const lower = query.toLowerCase();
  return parts.map((part, i) =>
    part.toLowerCase() === lower ? <mark key={i}>{part}</mark> : part,
  );
}

/* ---------------- Vditor 编辑器（迁移自宿主 Editor，AI 摘要经跨插件 core-ai） ---------------- */

/** Vditor 实例的结构子集（工具栏回调用到的 API） */
type VdLike = {
  getSelection: () => string;
  replaceSelection: (value: string) => void;
  tip: (text: string, time?: number) => void;
};

const TOOLBAR = [
  "undo",
  "redo",
  "|",
  "headings",
  "bold",
  "italic",
  "strike",
  "|",
  "list",
  "ordered-list",
  "check",
  "|",
  "quote",
  "inline-code",
  "code",
  "link",
  "table",
  "|",
  "edit-mode",
];

function NoteEditor({
  api,
  doc,
  onChange,
  onSave,
  dark,
  placeholderText,
}: {
  api: PluginBridgeApi;
  doc: string;
  onChange: (doc: string) => void;
  onSave: () => void;
  dark: boolean;
  placeholderText?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const vdRef = useRef<Vditor | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const aiBusyRef = useRef(false);

  /* 主题切换不重建实例：直接调 Vditor setTheme，保留撤销栈/光标/滚动位置 */
  useEffect(() => {
    try {
      vdRef.current?.setTheme(dark ? "dark" : "classic");
    } catch {
      /* 旧版 Vditor 无 setTheme：忽略，下次重建时生效 */
    }
  }, [dark]);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  /* M6：选中文本 → AI 摘要 → 以引用块替换选区（跨插件 core-ai） */
  const handleAiSummary = async (vd: VdLike) => {
    if (aiBusyRef.current) return;
    const sel = vd.getSelection();
    if (!sel?.trim()) {
      vd.tip("请先在编辑器中选中要摘要的文本", 2000);
      return;
    }
    aiBusyRef.current = true;
    setAiBusy(true);
    try {
      const reply = (await api.call(
        "ai.chat",
        {
          messages: [
            {
              role: "system",
              content: "你是精炼的摘要助手。用 3-5 条要点总结用户文本，使用中文，只输出摘要。",
            },
            { role: "user", content: sel.slice(0, 6000) },
          ],
        },
        "core-ai",
      )) as string;
      const block = `\n\n> **AI 摘要**\n${reply
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}\n`;
      vd.replaceSelection(block);
    } catch (e) {
      const msg = String(e);
      vd.tip(
        msg.includes("未配置 API Key") ? "未配置 AI —— 请到设置页填写" : msg.slice(0, 80),
        3000,
      );
    } finally {
      aiBusyRef.current = false;
      setAiBusy(false);
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    try {
      const vd = new Vditor(host, {
        height: "100%",
        mode: "ir",
        theme: dark ? "dark" : "classic",
        lang: "zh_CN",
        icon: "ant",
        // 与宿主共享 /vditor 静态资源（宿主始终打包该目录，离线可用）
        cdn: "/vditor",
        placeholder: placeholderText ?? "",
        value: doc,
        cache: { enable: false },
        counter: { enable: false },
        outline: { enable: false, position: "right" },
        toolbar: [
          ...TOOLBAR,
          "|",
          {
            name: "ai-summary",
            icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z"/></svg>',
            tip: aiBusy ? "AI 摘要生成中…" : "AI 摘要（选中文本）",
            click: (_event: Event, vditor: unknown) => {
              void handleAiSummary(vditor as VdLike);
            },
          },
        ],
        input: (value) => onChangeRef.current(value),
        blur: () => onSaveRef.current(),
        after: () => {
          const raf = requestAnimationFrame(() => {
            try {
              vd.focus();
            } catch {
              /* 编辑器可能已在下一帧前销毁 */
            }
          });
          (vd as unknown as { __raf?: number }).__raf = raf;
          vdRef.current = vd;
        },
      });

      return () => {
        try {
          vdRef.current = null;
          const raf = (vd as unknown as { __raf?: number }).__raf;
          if (raf) cancelAnimationFrame(raf);
          vd.destroy();
        } catch (e) {
          console.error("[vditor-destroy]", e);
        }
      };
    } catch (e) {
      console.error("[vditor-init]", e);
      setInitError(e instanceof Error ? e.message : String(e));
    }
    // 组件按 key 重建：仅在挂载时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (initError) {
    return (
      <div className="editor-error">
        <p>编辑器初始化失败：</p>
        <pre>{initError}</pre>
      </div>
    );
  }

  return <div className="editor-host" ref={hostRef} />;
}

/* ---------------- 本地工具 ---------------- */

function loadPref(key: string, def: boolean): boolean {
  try {
    return localStorage.getItem(`toolbox.${key}`) === "1";
  } catch {
    return def;
  }
}

function savePref(key: string, value: boolean) {
  try {
    localStorage.setItem(`toolbox.${key}`, value ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

/* ---- 注册到全局（宿主 PluginUiView 注入后读取） ---- */
declare global {
  interface Window {
    __TB_PLUGIN_UI__?: Record<
      string,
      { mount: (el: HTMLElement, api: PluginBridgeApi) => void; unmount?: () => void }
    >;
  }
}

let root: Root | null = null;
window.__TB_PLUGIN_UI__ = window.__TB_PLUGIN_UI__ || {};
window.__TB_PLUGIN_UI__["core-notes"] = {
  mount(el, api) {
    root = createRoot(el);
    root.render(<NotesPluginUi api={api} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
