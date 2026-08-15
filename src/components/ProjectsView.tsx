import { useEffect, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import { useProjects } from "../core/projects";
import { useVault } from "../core/vault";
import {
  IconArrowLeft,
  IconChevronRight,
  IconFileArchive,
  IconFileCode,
  IconFileDoc,
  IconFileImage,
  IconFileSheet,
  IconFolder,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 项目文件管理视图（M8）：
 * - 列表页：进行中 / 已归档项目，新建 / 归档 / 还原 / 删除
 * - 详情页：文件浏览器（目录进入、面包屑回退、文件用默认应用打开）
 */
export function ProjectsView() {
  const vault = useVault();
  const p = useProjects();

  return (
    <div className="projects-view">
      <header className="view-header">
        <div>
          <h1>项目</h1>
          <p className="view-sub">管理项目文件 —— 归档、浏览，点击用默认应用打开</p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={() => void p.refresh()} disabled={p.loading}>
            <IconRefresh width={14} height={14} />
            {p.loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      {p.notice && <div className="projects-notice">{p.notice}</div>}

      {!vault.path ? (
        <div className="empty-state">
          <IconFolder width={28} height={28} />
          <p>请先在顶栏选择一个工作区，再管理项目</p>
        </div>
      ) : p.current === null ? (
        <ProjectList />
      ) : (
        <ProjectDetail />
      )}
    </div>
  );
}

/* ================= 列表页 ================= */

function ProjectList() {
  const p = useProjects();
  const [newName, setNewName] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const create = () => {
    if (!newName.trim()) return;
    void p.create(newName);
    setNewName("");
  };

  const remove = (name: string) => {
    void p.remove(name);
  };

  const active = p.projects.filter((x) => !x.archived);
  const archived = p.projects.filter((x) => x.archived);

  return (
    <>
      {/* 新建项目 */}
      <div className="projects-new">
        <input
          className="projects-new-input"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
          }}
          placeholder="输入项目名称，回车创建（文件夹位于工作区 projects/ 下）"
          spellCheck={false}
        />
        <button className="btn btn-primary" onClick={create} disabled={!newName.trim()}>
          <IconPlus width={14} height={14} />
          新建项目
        </button>
      </div>

      <ProjectSection
        title={`进行中（${active.length}）`}
        items={active}
        emptyText="还没有项目 —— 新建一个，或把已有文件夹放进工作区 projects/ 目录"
        onOpen={p.openProject}
        actions={(name) => (
          <>
            <button className="btn btn-sm" onClick={() => void p.archive(name)}>
              归档
            </button>
            <button className="btn btn-sm danger" onClick={() => setConfirmDel(name)}>
              <IconTrash width={12} height={12} />
              删除
            </button>
          </>
        )}
      />

      <ProjectSection
        title={`已归档（${archived.length}）`}
        items={archived}
        emptyText="归档的项目会出现在这里"
        onOpen={p.openProject}
        actions={(name) => (
          <>
            <button className="btn btn-sm" onClick={() => void p.unarchive(name)}>
              还原
            </button>
            <button className="btn btn-sm danger" onClick={() => setConfirmDel(name)}>
              <IconTrash width={12} height={12} />
              删除
            </button>
          </>
        )}
      />
      <ConfirmDialog
        open={confirmDel !== null}
        title="删除项目"
        message={confirmDel ? `确定删除项目「${confirmDel}」？将移入系统回收站。` : ""}
        confirmText="删除"
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          if (confirmDel) remove(confirmDel);
          setConfirmDel(null);
        }}
      />
    </>
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
              <button className="project-card-main" onClick={() => onOpen(it.name)} title={`打开项目 ${it.name}`}>
                <IconFolder className="module-icon" width={18} height={18} />
                <span className="project-card-name">{it.name}</span>
                <span className="project-card-meta">{it.fileCount} 个文件</span>
                <IconChevronRight className="project-card-chevron" width={14} height={14} />
              </button>
              <div className="project-card-actions">{actions(it.name)}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ================= 详情页（文件浏览器） ================= */

function ProjectDetail() {
  const p = useProjects();
  const current = p.current ?? "";
  const crumbs = p.cwd ? p.cwd.split("/") : [];

  /* 快捷键：Backspace 返回上级（输入框内不触发） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Backspace" && p.cwd) {
        e.preventDefault();
        p.backDir();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.cwd, p.backDir]);

  return (
    <div className="project-detail">
      <div className="project-detail-head">
        <button className="btn btn-sm" onClick={p.closeProject}>
          <IconArrowLeft width={13} height={13} />
          全部项目
        </button>
        <h2 className="project-detail-title">{current}</h2>
        <span className="project-detail-path">工作区/projects/{current}</span>
      </div>

      {/* 面包屑 */}
      <div className="project-crumbs">
        <button className="crumb" onClick={() => void p.enterDir("")}>
          {current}
        </button>
        {crumbs.map((c, i) => {
          const dir = crumbs.slice(0, i + 1).join("/");
          return (
            <span key={dir} className="crumb-seg">
              <IconChevronRight width={10} height={10} />
              <button className="crumb" onClick={() => void p.enterDir(dir)}>
                {c}
              </button>
            </span>
          );
        })}
      </div>

      {p.fileLoading ? (
        <div className="search-hint">加载中…</div>
      ) : p.files === null ? (
        <div className="tool-result empty">无法读取项目目录</div>
      ) : p.files.length === 0 ? (
        <div className="tool-result empty">
          项目文件夹是空的 —— 可在资源管理器中添加文件
          <button
            className="btn btn-sm project-empty-open"
            onClick={() => void p.openFolder("")}
          >
            打开文件夹
          </button>
        </div>
      ) : (
        <div className="project-file-list">
          {p.files.map((f) => (
            <FileRow key={f.path} name={f.name} path={f.path} isDir={f.isDir} size={f.size} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({ name, path, isDir, size }: { name: string; path: string; isDir: boolean; size: number | null }) {
  const p = useProjects();
  const { Icon, kind } = fileKind(name);
  return (
    <div className={`project-file-row${isDir ? " dir" : ""}`}>
      <button
        className="project-file-main"
        title={isDir ? `进入 ${name}` : `用默认应用打开 ${name}`}
        onClick={() => (isDir ? void p.enterDir(path) : void p.openFile(path))}
      >
        <Icon className={`file-kind file-kind-${kind}`} width={16} height={16} />
        <span className="project-file-name">{name}</span>
        <span className="project-file-size">{isDir ? "" : formatSize(size)}</span>
      </button>
      {isDir && (
        <button
          className="btn btn-sm project-file-open"
          title="在资源管理器中打开该文件夹"
          onClick={() => void p.openFolder(path)}
        >
          打开文件夹
        </button>
      )}
    </div>
  );
}

/* ---------------- 工具 ---------------- */

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

/** 按扩展名映射文件类型图标 */
function fileKind(name: string): { Icon: ComponentType<SVGProps<SVGSVGElement>>; kind: string } {
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext))
    return { Icon: IconFileImage, kind: "image" };
  if (["xls", "xlsx", "csv", "tsv", "ods"].includes(ext))
    return { Icon: IconFileSheet, kind: "sheet" };
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(ext))
    return { Icon: IconFileArchive, kind: "archive" };
  if (["js", "ts", "py", "rs", "go", "java", "c", "cpp", "json", "html", "css", "sql", "xml", "sh"].includes(ext))
    return { Icon: IconFileCode, kind: "code" };
  return { Icon: IconFileDoc, kind: "doc" };
}
