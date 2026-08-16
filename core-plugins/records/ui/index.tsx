// core-records 插件自带前端（组件模式）：工作记录列表 + 编辑器（M4）。
// 依赖 React（构建进 IIFE）；宿主注入统一 api 桥；CSS 复用宿主全局样式
// （.records-* 等 class 在宿主 app.css 中，组件注入宿主 React 树内直接生效）。
//
// 由宿主 RecordsView（视图）+ src/core/records.tsx（数据层）迁移而来：
//   - 数据操作经 api.call 调本插件命令：records.list / records.create /
//     records.save / records.delete（插件在保存时统一刷新 updatedAt 并返回）
//   - 写操作后插件推送 records-changed，经 api.on 订阅后刷新列表（多窗口一致）
//   - [[笔记]] 断链检测经跨插件 api.call("notes.list", {}, "core-notes")
//     拿笔记文件索引；点击打开经 api.nav?.openNote（宿主未提供 nav 时仅展示）
//   - 宿主原「导航参数 openRecordId 打开指定记录」依赖宿主路由参数，
//     插件 context 无该参数，此处不实现（保留列表选择打开）。
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/** 宿主注入的桥 API（PluginUiView 构造）——只声明本组件用到的部分 */
interface PluginBridgeApi {
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  /** 订阅本插件 plugin-event，返回取消函数；targetPluginId 可跨插件 */
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  context: { vault: string | null };
  /** 可选：打开笔记（宿主未注入时点击链接不跳转，仅展示） */
  nav?: { openNote(rel: string): void };
}

/** 工作记录（与插件 store 的 RecordData 字段一致） */
interface RecordData {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  tags: string[];
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** core-notes 的 notes.list 返回项（vault 相对路径，/ 分隔，isDir/size 已 camelCase） */
interface NoteFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

/* ---------------- 内联小图标（插件独立构建，不共享宿主 icons） ---------------- */
/* 路径与描边参数照抄宿主 src/components/icons.tsx，保证同 document 内视觉一致 */

const svg = (children: React.ReactNode, size = 14) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
const IconPlus = (p: { width?: number; height?: number }) =>
  svg(<path d="M12 5v14M5 12h14" />, p.width ?? 14);
const IconTrash = (p: { width?: number; height?: number }) =>
  svg(
    <>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12" />
      <path d="M10 11v6M14 11v6" />
    </>,
    p.width ?? 12
  );
const IconFileText = (p: { width?: number; height?: number }) =>
  svg(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>,
    p.width ?? 12
  );

/* ---------------- 主组件 ---------------- */

export function RecordsPluginUi({ api }: { api: PluginBridgeApi }) {
  const vault = api.context.vault;

  const [records, setRecords] = useState<RecordData[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RecordData | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagText, setTagText] = useState("");
  const [confirmDel, setConfirmDel] = useState<{ id: string; title: string } | null>(null);
  /** 笔记文件索引（跨插件 notes.list），用于 [[笔记]] 断链检测 */
  const [noteFiles, setNoteFiles] = useState<NoteFileEntry[]>([]);

  const draftRef = useRef<RecordData | null>(null);
  draftRef.current = draft;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- 数据层（原 src/core/records.tsx 的 RecordsProvider 逻辑并入本组件） ---- */

  /** 与插件/宿主一致：date 倒序，同日 createdAt 新者在前 */
  const sortRecords = (arr: RecordData[]) =>
    [...arr].sort((a, b) =>
      a.date === b.date
        ? a.createdAt < b.createdAt
          ? 1
          : -1
        : a.date < b.date
          ? 1
          : -1
    );

  const refresh = async () => {
    if (!vault) {
      setRecords([]);
      return;
    }
    setLoading(true);
    try {
      setRecords(sortRecords((await api.call("records.list", {})) as RecordData[]));
    } catch (e) {
      console.error("[records] 刷新失败", e);
    } finally {
      setLoading(false);
    }
  };

  /** 拉取笔记文件索引（断链检测用；跨插件调用 core-notes） */
  const loadNotes = async () => {
    if (!vault) {
      setNoteFiles([]);
      return;
    }
    try {
      setNoteFiles((await api.call("notes.list", {}, "core-notes")) as NoteFileEntry[]);
    } catch (e) {
      console.error("[records] 读取笔记列表失败", e);
      setNoteFiles([]);
    }
  };

  useEffect(() => {
    void refresh();
    void loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, vault]);

  /* 写操作后插件推送 records-changed：刷新列表（多窗口一致） */
  useEffect(() => {
    const un = api.on("records-changed", () => {
      void refresh();
    });
    return un;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, vault]);

  const create = async (partial: Partial<RecordData> = {}): Promise<RecordData | null> => {
    if (!vault) return null;
    try {
      const r = (await api.call("records.create", { partial })) as RecordData;
      await refresh();
      return r;
    } catch (e) {
      console.error("[records] 创建失败", e);
      return null;
    }
  };

  const save = async (record: RecordData): Promise<void> => {
    try {
      // 插件统一刷新 updatedAt，返回更新后的记录
      const saved = (await api.call("records.save", { record })) as RecordData;
      if (saved) {
        // 基于最新快照同步更新（排序与插件 list 一致）
        setRecords((prev) => sortRecords(prev.map((r) => (r.id === saved.id ? saved : r))));
      }
    } catch (e) {
      console.error("[records] 保存失败", e);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api.call("records.delete", { id });
    } catch (e) {
      console.error(`[records] 删除失败 ${id}`, e);
    }
    await refresh();
  };

  /** [[笔记]] 链接提取（与宿主实现一致） */
  const extractLinks = (content: string): string[] => {
    const out: string[] = [];
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const t = m[1].trim();
      if (t) out.push(t);
    }
    return out;
  };

  /* ---- 草稿机制（照抄宿主 RecordsView）：draftRef + 800ms 防抖落盘 ---- */

  /** 立即排空待保存草稿（返回完成 promise，供删除等需要先落盘的场景） */
  const flush = (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const d = draftRef.current;
    if (d) {
      draftRef.current = null;
      return save(d);
    }
    return Promise.resolve();
  };

  const scheduleSave = (record: RecordData) => {
    draftRef.current = record;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const d = draftRef.current;
      if (d) {
        draftRef.current = null;
        void save(d);
      }
    }, 800);
  };

  /** 在 updater 外基于最新草稿计算 next（副作用调度移出 updater） */
  const update = (patch: Partial<RecordData>) => {
    const cur = draftRef.current;
    if (!cur) return;
    const next = { ...cur, ...patch };
    setDraft(next);
    scheduleSave(next);
  };

  /* 打开记录：先把未保存的草稿刷掉，再加载目标 */
  const openRecord = (id: string) => {
    void flush();
    const r = records.find((x) => x.id === id);
    if (r) {
      setCurrentId(id);
      setDraft({ ...r });
      setTagText(r.tags.join(", "));
    }
  };

  const newRecord = async () => {
    await flush();
    const r = await create();
    if (r) {
      setCurrentId(r.id);
      setDraft({ ...r });
      setTagText("");
    }
  };

  const deleteRecord = async (id: string) => {
    if (currentId === id) {
      await flush(); // 先落盘待保存内容，避免被删除文件被写回
      setCurrentId(null);
      setDraft(null);
    }
    await remove(id);
  };

  const commitTags = () => {
    const tags = tagText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean);
    update({ tags });
  };

  const exportMd = () => {
    const md = records
      .map(
        (r) =>
          `## ${r.title}\n\n- 日期：${r.date}\n- 标签：${r.tags.join("、") || "无"}\n\n${r.content}\n`
      )
      .join("\n---\n\n");
    const blob = new Blob([`# 工作记录导出\n\n${md}`], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `records-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ---- 筛选与统计 ---- */
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) for (const t of r.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [records]);

  const months = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) m.set(r.date.slice(0, 7), (m.get(r.date.slice(0, 7)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [records]);

  const filtered = tagFilter ? records.filter((r) => r.tags.includes(tagFilter)) : records;

  const links = draft ? extractLinks(draft.content) : [];

  return (
    <div className="records-view">
      {!vault ? (
        /* 无工作区：仅提示，不渲染列表与编辑器 */
        <div className="empty-state">
          <IconFileText width={28} height={28} />
          <p>请先在顶栏选择工作区</p>
        </div>
      ) : (
        <>
          {/* ---- 左：列表 ---- */}
          <aside className="records-pane">
            <div className="records-pane-head">
              <span className="records-pane-title">记录</span>
              <span className="records-count">{records.length}</span>
            </div>
            <div className="records-pane-actions">
              <button className="btn btn-sm" onClick={() => void newRecord()}>
                <IconPlus width={12} height={12} />
                新建
              </button>
              <button className="btn btn-sm" onClick={exportMd} disabled={records.length === 0}>
                导出 Markdown
              </button>
            </div>

            <div className="records-filter">
              <div className="records-stats">
                <span className="records-stats-title">统计</span>
                <span className="records-stats-row">共 {records.length} 条</span>
                <span className="records-stats-row">
                  {months.length} 个月 · {allTags.length} 个标签
                </span>
              </div>
              {allTags.length > 0 && (
                <div className="records-tags">
                  <button
                    className={`record-tag-chip${!tagFilter ? " active" : ""}`}
                    onClick={() => setTagFilter(null)}
                  >
                    全部
                  </button>
                  {allTags.map(([t, n]) => (
                    <button
                      key={t}
                      className={`record-tag-chip${tagFilter === t ? " active" : ""}`}
                      onClick={() => setTagFilter(tagFilter === t ? null : t)}
                    >
                      {t} {n}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="records-list">
              {records.length === 0 && !loading && (
                <div className="tree-empty">
                  <p>还没有记录</p>
                  <p className="tree-empty-hint">点击「新建」开始记录</p>
                </div>
              )}
              {filtered.map((r) => (
                <div
                  key={r.id}
                  className={`record-row${currentId === r.id ? " active" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-current={currentId === r.id ? "true" : undefined}
                  onClick={() => openRecord(r.id)}
                  onKeyDown={(e) => rowKeyDown(e, () => openRecord(r.id))}
                >
                  <div className="record-row-date">{r.date}</div>
                  <div className="record-row-title">{r.title}</div>
                  <div className="record-row-actions">
                    <button
                      className="tree-action danger"
                      title="删除记录"
                      aria-label={`删除记录 ${r.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDel({ id: r.id, title: r.title });
                      }}
                    >
                      <IconTrash width={12} height={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </aside>

          {/* ---- 右：编辑器 ---- */}
          <section className="records-main" aria-label="记录编辑器">
            {!draft ? (
              <div className="empty-state">
                <h2>工作记录</h2>
                <p>新建一条记录，或在左侧选择</p>
              </div>
            ) : (
              <div className="record-editor">
                <input
                  className="record-title-input"
                  value={draft.title}
                  onChange={(e) => update({ title: e.target.value })}
                  placeholder="记录标题"
                  spellCheck={false}
                />
                <div className="record-meta-row">
                  <input
                    type="date"
                    className="record-date-input"
                    value={draft.date}
                    onChange={(e) => update({ date: e.target.value })}
                  />
                  <input
                    className="record-tags-input"
                    value={tagText}
                    onChange={(e) => setTagText(e.target.value)}
                    onBlur={commitTags}
                    onKeyDown={(e) => e.key === "Enter" && commitTags()}
                    placeholder="标签（逗号分隔）"
                    spellCheck={false}
                  />
                </div>
                <textarea
                  className="record-content-input"
                  value={draft.content}
                  onChange={(e) => update({ content: e.target.value })}
                  placeholder="记录内容…支持 [[笔记路径]] 链接笔记"
                  spellCheck={false}
                />
                {links.length > 0 && (
                  <div className="record-links">
                    <span className="record-links-label">关联笔记</span>
                    {links.map((l) => {
                      // 断链提示：目标笔记已不存在时标灰（点开会报错）
                      const broken = !noteFiles.some(
                        (f) => f.path === `notes/${l.replace(/^notes\//, "")}`
                      );
                      return (
                        <button
                          key={l}
                          className={`note-link${broken ? " broken" : ""}`}
                          onClick={() => api.nav?.openNote(l)}
                          title={broken ? `${l}（笔记不存在）` : `打开 ${l}`}
                        >
                          <IconFileText width={12} height={12} />
                          {l.split("/").pop()}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </>
      )}

      <ConfirmDialog
        title="删除记录"
        message={confirmDel ? `确定删除记录「${confirmDel.title}」？此操作不可撤销。` : ""}
        confirmText="删除"
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          if (confirmDel) void deleteRecord(confirmDel.id);
          setConfirmDel(null);
        }}
      />
    </div>
  );
}

/** 让 role="button" 的可点击容器支持 Enter/Space（等价宿主 src/core/keyboard.ts 的 onRowKeyDown） */
function rowKeyDown(e: React.KeyboardEvent, activate: () => void) {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    activate();
  }
}

/** 删除确认弹窗：复用宿主 .confirm-overlay/.confirm-dialog 全局 class */
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
window.__TB_PLUGIN_UI__["core-records"] = {
  mount(el, api) {
    root = createRoot(el);
    root.render(<RecordsPluginUi api={api} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
