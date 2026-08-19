// core-projects 插件自带前端（组件模式）：列表 + 详情（文件浏览器）。
// 依赖 React（构建进 IIFE）；宿主注入统一 api 桥；CSS 复用宿主全局样式
// （.projects-* 等 class 在宿主 app.css 中，组件注入宿主 React 树内直接生效）。
import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/** 宿主注入的桥 API（PluginUiView 构造） */
interface PluginBridgeApi {
  pluginId: string;
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  on: (event: string, cb: (data: unknown) => void) => () => void;
  context: { vault: string | null };
}

interface ProjectInfo {
  name: string;
  archived: boolean;
  fileCount: number;
}

interface ProjectFile {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

/* ---------------- 内联小图标（插件独立构建，不共享宿主 icons） ---------------- */

const svg = (children: React.ReactNode, size = 14) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
const IconFolder = (p: { width?: number; height?: number; className?: string }) =>
  svg(
    <>
      <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    </>,
    p.width ?? 14,
  );
const IconPlus = () => svg(<path d="M12 5v14M5 12h14" />, 14);
const IconRefresh = () => svg(<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />, 14);
const IconTrash = () =>
  svg(
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />,
    12,
  );
const IconChevronRight = () => svg(<path d="M9 6l6 6-6 6" />, 12);
const IconArrowLeft = () => svg(<path d="M19 12H5M12 19l-7-7 7-7" />, 13);
const IconFile = () =>
  svg(<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8zM14 3v5h5" />, 16);

/* ---------------- 主组件 ---------------- */

export function ProjectsPluginUi({ api }: { api: PluginBridgeApi }) {
  const vault = api.context.vault;
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2500);
  };

  /* 卸载时清理 notice 定时器，避免卸载后仍 setNotice */
  useEffect(() => {
    return () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const refresh = async () => {
    if (!vault) {
      setProjects([]);
      return;
    }
    setLoading(true);
    try {
      setProjects((await api.call("projects.list")) as ProjectInfo[]);
    } catch (e) {
      flash(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const loadFiles = async (proj: string, dir: string) => {
    if (!vault || !proj) {
      setFiles(null);
      return;
    }
    setFileLoading(true);
    try {
      setFiles((await api.call("projects.files", { name: proj, dir })) as ProjectFile[]);
    } catch (e) {
      setFiles(null);
      flash(String(e));
    } finally {
      setFileLoading(false);
    }
  };

  useEffect(() => {
    void loadFiles(current ?? "", cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, cwd]);

  const create = async () => {
    const name = newName.trim();
    if (!name || !vault) return;
    try {
      await api.call("projects.create", { name });
      setNewName("");
      await refresh();
      flash(`已创建项目 ${name}`);
    } catch (e) {
      flash(String(e));
    }
  };

  const archive = async (name: string) => {
    try {
      await api.call("projects.archive", { name });
      if (current === name) {
        setCurrent(null);
        setCwd("");
      }
      await refresh();
      flash(`已归档 ${name}`);
    } catch (e) {
      flash(String(e));
    }
  };

  const unarchive = async (name: string) => {
    try {
      await api.call("projects.unarchive", { name });
      await refresh();
      flash(`已还原 ${name}`);
    } catch (e) {
      flash(String(e));
    }
  };

  const remove = async (name: string) => {
    try {
      await api.call("projects.delete", { name });
      if (current === name) {
        setCurrent(null);
        setCwd("");
      }
      await refresh();
      flash(`已删除 ${name}`);
    } catch (e) {
      flash(String(e));
    }
  };

  const openFile = async (rel: string) => {
    if (!current) return;
    try {
      await api.call("projects.open", { name: current, rel });
      flash(`已用默认应用打开 ${rel.split("/").pop()}`);
    } catch (e) {
      flash(String(e));
    }
  };

  const openFolder = async (rel: string) => {
    if (!current) return;
    try {
      await api.call("projects.open", { name: current, rel });
      flash(`已打开文件夹 ${rel || "(项目根)"}`);
    } catch (e) {
      flash(String(e));
    }
  };

  const backDir = () => {
    setCwd((prev) => {
      const idx = prev.lastIndexOf("/");
      return idx === -1 ? "" : prev.slice(0, idx);
    });
  };

  /* 快捷键：Backspace 返回上级（输入框内不触发） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Backspace" && current && cwd) {
        e.preventDefault();
        backDir();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, cwd]);

  const active = projects.filter((x) => !x.archived);
  const archived = projects.filter((x) => x.archived);
  const crumbs = cwd ? cwd.split("/") : [];

  return (
    <div className="projects-view">
      <header className="view-header">
        <div>
          <h1>项目</h1>
          <p className="view-sub">管理项目文件 —— 归档、浏览，点击用默认应用打开</p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={() => void refresh()} disabled={loading}>
            <IconRefresh />
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      {notice && <div className="projects-notice">{notice}</div>}

      {!vault ? (
        <div className="empty-state">
          <IconFolder width={28} height={28} />
          <p>请先在顶栏选择一个工作区，再管理项目</p>
        </div>
      ) : current === null ? (
        <>
          {/* 列表页 */}
          <div className="projects-new">
            <input
              className="projects-new-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
              placeholder="输入项目名称，回车创建（文件夹位于工作区 projects/ 下）"
              spellCheck={false}
            />
            <button
              className="btn btn-primary"
              onClick={() => void create()}
              disabled={!newName.trim()}
            >
              <IconPlus />
              新建项目
            </button>
          </div>

          <ProjectSection
            title={`进行中（${active.length}）`}
            items={active}
            emptyText="还没有项目 —— 新建一个，或把已有文件夹放进工作区 projects/ 目录"
            onOpen={(name) => {
              setCurrent(name);
              setCwd("");
            }}
            actions={(name) => (
              <>
                <button className="btn btn-sm" onClick={() => void archive(name)}>
                  归档
                </button>
                <button className="btn btn-sm danger" onClick={() => setConfirmDel(name)}>
                  <IconTrash />
                  删除
                </button>
              </>
            )}
          />

          <ProjectSection
            title={`已归档（${archived.length}）`}
            items={archived}
            emptyText="归档的项目会出现在这里"
            onOpen={(name) => {
              setCurrent(name);
              setCwd("");
            }}
            actions={(name) => (
              <>
                <button className="btn btn-sm" onClick={() => void unarchive(name)}>
                  还原
                </button>
                <button className="btn btn-sm danger" onClick={() => setConfirmDel(name)}>
                  <IconTrash />
                  删除
                </button>
              </>
            )}
          />

          {confirmDel && (
            <ConfirmDialog
              title="删除项目"
              message={`确定删除项目「${confirmDel}」？将移入系统回收站。`}
              onCancel={() => setConfirmDel(null)}
              onConfirm={() => {
                void remove(confirmDel);
                setConfirmDel(null);
              }}
            />
          )}
        </>
      ) : (
        /* 详情页（文件浏览器） */
        <div className="project-detail">
          <div className="project-detail-head">
            <button
              className="btn btn-sm"
              onClick={() => {
                setCurrent(null);
                setCwd("");
                setFiles(null);
              }}
            >
              <IconArrowLeft />
              全部项目
            </button>
            <h2 className="project-detail-title">{current}</h2>
            <span className="project-detail-path">工作区/projects/{current}</span>
          </div>

          <div className="project-crumbs">
            <button className="crumb" onClick={() => setCwd("")}>
              {current}
            </button>
            {crumbs.map((c, i) => {
              const dir = crumbs.slice(0, i + 1).join("/");
              return (
                <span key={dir} className="crumb-seg">
                  <IconChevronRight />
                  <button className="crumb" onClick={() => setCwd(dir)}>
                    {c}
                  </button>
                </span>
              );
            })}
          </div>

          {fileLoading ? (
            <div className="search-hint">加载中…</div>
          ) : files === null ? (
            <div className="tool-result empty">无法读取项目目录</div>
          ) : files.length === 0 ? (
            <div className="tool-result empty">
              项目文件夹是空的 —— 可在资源管理器中添加文件
              <button className="btn btn-sm project-empty-open" onClick={() => void openFolder("")}>
                打开文件夹
              </button>
            </div>
          ) : (
            <div className="project-file-list">
              {files.map((f) => (
                <div className={`project-file-row${f.isDir ? " dir" : ""}`} key={f.path}>
                  <button
                    className="project-file-main"
                    title={f.isDir ? `进入 ${f.name}` : `用默认应用打开 ${f.name}`}
                    onClick={() => (f.isDir ? setCwd(f.path) : void openFile(f.path))}
                  >
                    <span className="file-kind file-kind-doc">
                      <IconFile />
                    </span>
                    <span className="project-file-name">{f.name}</span>
                    <span className="project-file-size">{f.isDir ? "" : formatSize(f.size)}</span>
                  </button>
                  {f.isDir && (
                    <button
                      className="btn btn-sm project-file-open"
                      title="在资源管理器中打开该文件夹"
                      onClick={() => void openFolder(f.path)}
                    >
                      打开文件夹
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectSection({
  title,
  items,
  emptyText,
  onOpen,
  actions,
}: {
  title: string;
  items: { name: string; fileCount: number }[];
  emptyText: string;
  onOpen: (name: string) => void;
  actions: (name: string) => React.ReactNode;
}) {
  return (
    <section className="projects-section">
      <h2 className="section-title">{title}</h2>
      {items.length === 0 ? (
        <div className="tool-result empty">{emptyText}</div>
      ) : (
        <div className="project-list">
          {items.map((it) => (
            <div className="project-card" key={it.name}>
              <button
                className="project-card-main"
                onClick={() => onOpen(it.name)}
                title={`打开项目 ${it.name}`}
              >
                <IconFolder className="module-icon" width={18} height={18} />
                <span className="project-card-name">{it.name}</span>
                <span className="project-card-meta">{it.fileCount} 个文件</span>
                <IconChevronRight />
              </button>
              <div className="project-card-actions">{actions(it.name)}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ConfirmDialog({
  title,
  message,
  confirmText = "删除",
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmText?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatSize(n: number | null): string {
  if (n === null || n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
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
window.__TB_PLUGIN_UI__["core-projects"] = {
  mount(el, api) {
    root = createRoot(el);
    root.render(<ProjectsPluginUi api={api} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
