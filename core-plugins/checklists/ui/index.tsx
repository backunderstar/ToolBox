// core-checklists 插件自带前端（组件模式）：清单列表 + 编辑器（打卡/进度/笔记关联）。
// 依赖 React（构建进 IIFE）；宿主注入统一 api 桥；CSS 复用宿主全局样式
// （.checklist-* 等 class 在宿主 app.css 中，组件注入宿主 React 树内直接生效）。
// 数据层由宿主 src/core/checklists.tsx 的 ChecklistProvider 并进本组件，经 api 桥替代
// useChecklists()/useVault()/useNav()；视图结构照抄宿主 src/components/ChecklistView.tsx。
import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/** 宿主注入的桥 API（PluginUiView 构造）——只声明本组件用到的字段 */
interface PluginBridgeApi {
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  context: { vault: string | null };
  /** 宿主导航（主窗口可用；独立窗口为 undefined） */
  nav?: { openNote(rel: string): void };
}

/** 清单条目 */
interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** 关联笔记（vault 相对路径） */
  note?: string;
}

/** 清单（data/checklists/<id>.json 的结构，与插件一致：camelCase） */
interface Checklist {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: ChecklistItem[];
}

/** 清单列表元信息（按 updatedAt 倒序） */
interface ChecklistMeta {
  id: string;
  title: string;
  done: number;
  total: number;
  updatedAt: string;
}

/** 跨插件 core-notes 文件条目（与宿主 vault.files 同构，用于笔记选择器与断链检测） */
interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

/* ---------------- 内联小图标（插件独立构建，不共享宿主 icons；路径抄宿主 icons.tsx） ---------------- */

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
const IconPlus = (p: { width?: number; height?: number } = {}) =>
  svg(<path d="M12 5v14M5 12h14" />, p.width ?? 14);
const IconTrash = (p: { width?: number; height?: number } = {}) =>
  svg(
    <>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12" />
      <path d="M10 11v6M14 11v6" />
    </>,
    p.width ?? 12
  );
const IconFileText = (p: { width?: number; height?: number } = {}) =>
  svg(
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h6" />
    </>,
    p.width ?? 12
  );

/* ---------------- 主组件（数据层 + 视图） ---------------- */

export function ChecklistsPluginUi({ api }: { api: PluginBridgeApi }) {
  const vault = api.context.vault;

  /* ---- 数据层状态（原 ChecklistProvider） ---- */
  const [metas, setMetas] = useState<ChecklistMeta[]>([]);
  const [current, setCurrent] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(false);

  /* ---- 视图状态（原 ChecklistView） ---- */
  const [newTitle, setNewTitle] = useState("");
  const [newItem, setNewItem] = useState("");
  const [pickingNote, setPickingNote] = useState<string | null>(null);
  const [noteQuery, setNoteQuery] = useState("");
  const [confirmDel, setConfirmDel] = useState<{ id: string; title: string } | null>(null);
  /** 跨插件文件列表（笔记选择器与断链检测的数据源） */
  const [notes, setNotes] = useState<FileEntry[]>([]);

  /* ---- 自动保存（800ms 防抖，与宿主一致） ---- */
  const AUTOSAVE = 800;
  const currentRef = useRef<Checklist | null>(null);
  currentRef.current = current;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 待保存快照：调度时捕获，避免切换清单/工作区后写错对象 */
  const pendingRef = useRef<Checklist | null>(null);

  /* ---- 数据层：读 ---- */

  const refresh = async () => {
    if (!vault) {
      setMetas([]);
      return;
    }
    setLoading(true);
    try {
      const all = (await api.call("chk.list")) as Checklist[];
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
    } catch (e) {
      console.error("[checklists] 刷新失败", e);
    } finally {
      setLoading(false);
    }
  };

  /** 跨插件取笔记文件列表（等价宿主 vault.files） */
  const loadNotes = async () => {
    if (!vault) {
      setNotes([]);
      return;
    }
    try {
      setNotes((await api.call("notes.list", {}, "core-notes")) as FileEntry[]);
    } catch (e) {
      console.error("[checklists] 读取笔记列表失败", e);
    }
  };

  /* ---- 数据层：写（mutate 模式 + 防抖保存） ---- */

  /** 写入：插件统一刷新 updatedAt，返回更新后的清单 */
  const persist = async (list: Checklist): Promise<Checklist | null> => {
    if (!vault) return null;
    return (await api.call("chk.save", { checklist: list })) as Checklist;
  };

  const save = async (list?: Checklist) => {
    const snapshot = list ?? pendingRef.current ?? currentRef.current;
    if (!snapshot) return;
    pendingRef.current = null;
    const updated = { ...snapshot, updatedAt: new Date().toISOString() };
    try {
      const saved = await persist(updated);
      // 保存期间产生了新的本地编辑（pendingRef 已重新置位）：保留本地未保存内容，
      // 避免服务端返回的旧快照覆盖正在输入的状态（宿主的 Provider 常驻无此竞态，插件需防护）
      if (!pendingRef.current) {
        // 仅当当前仍显示该清单时同步 UI（其余场景由后续刷新兜底）
        setCurrent((prev) =>
          saved && prev && prev.id === saved.id ? { ...saved } : prev
        );
      }
      await refresh();
    } catch (e) {
      console.error("[checklists] 保存失败", e);
      // 保留待保存快照，供重试
      pendingRef.current = snapshot;
    }
  };

  /** 立即冲洗待保存编辑（切换清单前调用，避免定时器触发时写错对象） */
  const flush = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const s = pendingRef.current;
    if (s) void save(s);
  };

  const scheduleSave = (snapshot: Checklist) => {
    pendingRef.current = snapshot;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const s = pendingRef.current;
      pendingRef.current = null;
      if (s) void save(s);
    }, AUTOSAVE);
  };

  /** 变更：在 updater 外基于最新已提交状态计算 next，副作用（调度保存）移出 updater */
  const mutate = (fn: (c: Checklist) => Checklist) => {
    const cur = currentRef.current;
    if (!cur) return;
    const next = fn(cur);
    setCurrent(next);
    scheduleSave(next);
  };

  /* ---- 数据层：CRUD ---- */

  const open = async (id: string) => {
    // 切换前冲洗当前清单的待保存编辑，避免定时器触发时写错对象
    flush();
    if (!vault) return;
    try {
      const c = (await api.call("chk.get", { id })) as Checklist | null;
      // 取数期间产生了新的本地编辑（chk-changed 事件驱动重取场景）：保留本地未保存内容
      if (pendingRef.current || saveTimer.current) return;
      setCurrent(c);
    } catch (e) {
      console.error(`[checklists] 打开失败 ${id}`, e);
    }
  };

  const create = async (title: string) => {
    const t = title.trim();
    if (!t || !vault) return;
    try {
      // 插件负责 id 生成与同名冲突加序号
      const r = (await api.call("chk.create", { title: t })) as Checklist;
      await refresh();
      await open(r.id);
    } catch (e) {
      console.error(`[checklists] 创建失败 ${t}`, e);
    }
  };

  const remove = async (id: string) => {
    if (!vault) return;
    try {
      await api.call("chk.delete", { id });
    } catch (e) {
      console.error(`[checklists] 删除失败 ${id}`, e);
    }
    if (currentRef.current?.id === id) setCurrent(null);
    await refresh();
  };

  const rename = (title: string) => {
    const t = title.trim();
    if (!t) return;
    mutate((c) => ({ ...c, title: t }));
  };

  const addItem = (text: string) => {
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
  };

  const toggleItem = (id: string) => {
    mutate((c) => ({
      ...c,
      items: c.items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)),
    }));
  };

  const removeItem = (id: string) => {
    mutate((c) => ({ ...c, items: c.items.filter((i) => i.id !== id) }));
  };

  const updateItem = (id: string, text: string) => {
    mutate((c) => ({
      ...c,
      items: c.items.map((i) => (i.id === id ? { ...i, text } : i)),
    }));
  };

  const setItemNote = (id: string, note: string | undefined) => {
    mutate((c) => ({
      ...c,
      items: c.items.map((i) =>
        i.id === id ? { ...i, note: note || undefined } : i
      ),
    }));
  };

  /* ---- 效果 ---- */

  /* 首次挂载刷新（插件视图随工作区切换整体重挂载，api 即最新上下文） */
  useEffect(() => {
    void refresh();
    void loadNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  /* 写操作后插件推送 chk-changed：刷新 metas；当前清单无本地编辑时重取（多窗口一致） */
  useEffect(() => {
    const un = api.on("chk-changed", () => {
      void refresh();
      void loadNotes();
      // 有未保存编辑时跳过重取，避免覆盖正在输入的内容
      if (currentRef.current && !pendingRef.current && !saveTimer.current) {
        void open(currentRef.current.id);
      }
    });
    return un;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  /* 卸载时冲洗待保存编辑：宿主 ChecklistProvider 应用级常驻不会卸载，
     插件视图切换即卸载，防抖窗口内的编辑会丢，这里补一次 flush */
  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const s = pendingRef.current;
      pendingRef.current = null;
      if (s && vault) {
        void api
          .call("chk.save", {
            checklist: { ...s, updatedAt: new Date().toISOString() },
          })
          .catch((e) => console.error("[checklists] 卸载保存失败", e));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 点击外部关闭笔记选择器（检查任意打开的 .note-picker，避免循环 ref 失效） */
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && !document.querySelector(".note-picker")?.contains(t)) {
        setPickingNote(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  /* ---- 视图逻辑 ---- */

  /* role="button" 行支持 Enter/Space 触发（等价宿主 keyboard.onRowKeyDown） */
  const rowKeyDown = (e: React.KeyboardEvent, activate: () => void) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  };

  const submitCreate = async () => {
    if (!newTitle.trim()) return;
    await create(newTitle);
    setNewTitle("");
  };

  const submitItem = () => {
    if (!newItem.trim()) return;
    addItem(newItem);
    setNewItem("");
  };

  const pickNote = (itemId: string, note: string) => {
    setItemNote(itemId, note);
    setPickingNote(null);
    setNoteQuery("");
  };

  /* 笔记选择器列表：Markdown 文件（等价宿主 vault.files 过滤） */
  const mdNotes = notes.filter(
    (f) => !f.isDir && f.path.toLowerCase().endsWith(".md")
  );

  const done = current?.items.filter((i) => i.done).length ?? 0;
  const total = current?.items.length ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="checklist-view">
      {!vault ? (
        /* ---- 无工作区 ---- */
        <div className="empty-state">
          <h2>清单</h2>
          <p>请先在顶栏选择一个工作区，再使用清单</p>
        </div>
      ) : (
        <>
          {/* ---- 左：清单列表 ---- */}
          <aside className="checklist-pane">
            <div className="checklist-pane-head">
              <span className="checklist-pane-title">清单</span>
              <span className="checklist-count">{metas.length}</span>
            </div>
            <div className="checklist-new">
              <input
                className="checklist-new-input"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submitCreate()}
                placeholder="新建清单…"
              />
              <button
                className="icon-btn sm"
                onClick={() => void submitCreate()}
                title="新建清单"
              >
                <IconPlus width={13} height={13} />
              </button>
            </div>
            <div className="checklist-list">
              {metas.length === 0 && !loading && (
                <div className="tree-empty">
                  <p>还没有清单</p>
                  <p className="tree-empty-hint">在上方输入名称创建</p>
                </div>
              )}
              {metas.map((m) => (
                <div
                  key={m.id}
                  className={`checklist-row${current?.id === m.id ? " active" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-current={current?.id === m.id ? "true" : undefined}
                  onClick={() => void open(m.id)}
                  onKeyDown={(e) => rowKeyDown(e, () => void open(m.id))}
                >
                  <div className="checklist-row-main">
                    <span className="checklist-row-title">{m.title}</span>
                    <span className="checklist-row-progress">
                      {m.done}/{m.total}
                    </span>
                  </div>
                  <div className="checklist-row-actions">
                    <button
                      className="tree-action danger"
                      title="删除清单"
                      aria-label={`删除清单 ${m.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDel({ id: m.id, title: m.title });
                      }}
                    >
                      <IconTrash width={12} height={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </aside>

          {/* ---- 右：清单编辑器 ---- */}
          <section className="checklist-main" aria-label="清单编辑器">
            {!current ? (
              <div className="empty-state">
                <h2>清单</h2>
                <p>选择一个清单开始打卡，或新建一个清单</p>
              </div>
            ) : (
              <div className="checklist-editor">
                <div className="checklist-editor-head">
                  <input
                    className="checklist-title-input"
                    value={current.title}
                    onChange={(e) => rename(e.target.value)}
                    spellCheck={false}
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => void refresh()}
                  >
                    刷新
                  </button>
                </div>

                <div className="checklist-progress">
                  <div className="checklist-progress-track">
                    <div
                      className="checklist-progress-fill"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="checklist-progress-text">
                    {done}/{total} · {pct}%
                  </span>
                </div>

                <ul className="checklist-items">
                  {current.items.map((item) => (
                    <li
                      key={item.id}
                      className={`checklist-item${item.done ? " done" : ""}`}
                    >
                      <label className="checklist-check">
                        <input
                          type="checkbox"
                          checked={item.done}
                          onChange={() => toggleItem(item.id)}
                        />
                      </label>
                      <input
                        className="checklist-item-text"
                        value={item.text}
                        onChange={(e) => updateItem(item.id, e.target.value)}
                        spellCheck={false}
                      />
                      <span className="checklist-item-note">
                        {item.note ? (
                          <button
                            className={`note-link${
                              // 断链提示：目标笔记已不存在时标灰（点开会报错）
                              notes.some((f) => f.path === item.note)
                                ? ""
                                : " broken"
                            }`}
                            onClick={() => api.nav?.openNote(item.note!)}
                            title={
                              notes.some((f) => f.path === item.note)
                                ? `打开 ${item.note}`
                                : `${item.note}（笔记不存在）`
                            }
                          >
                            <IconFileText width={12} height={12} />
                            {item.note.split("/").pop()}
                          </button>
                        ) : null}
                        <span className="note-pick-wrap">
                          <button
                            className="note-pick"
                            onClick={() => setPickingNote(pickingNote === item.id ? null : item.id)}
                            title="关联笔记"
                            aria-label="关联笔记"
                            aria-expanded={pickingNote === item.id}
                          >
                            <IconPlus width={11} height={11} />
                          </button>
                          {pickingNote === item.id && (
                            <div className="note-picker">
                              <input
                                className="note-picker-input"
                                value={noteQuery}
                                onChange={(e) => setNoteQuery(e.target.value)}
                                placeholder="搜索笔记…"
                                autoFocus
                              />
                              <div className="note-picker-list">
                                {mdNotes
                                  .filter((n) =>
                                    n.path.toLowerCase().includes(noteQuery.toLowerCase())
                                  )
                                  .map((n) => (
                                    <button
                                      key={n.path}
                                      className="note-picker-item"
                                      onClick={() => pickNote(item.id, n.path)}
                                    >
                                      {n.path}
                                    </button>
                                  ))}
                                {mdNotes.length === 0 && (
                                  <div className="note-picker-empty">工作区没有 Markdown 笔记</div>
                                )}
                              </div>
                            </div>
                          )}
                        </span>
                      </span>
                      <button
                        className="tree-action danger"
                        title="删除条目"
                        onClick={() => removeItem(item.id)}
                      >
                        <IconTrash width={12} height={12} />
                      </button>
                    </li>
                  ))}
                  {current.items.length === 0 && (
                    <li className="checklist-empty">添加第一个条目</li>
                  )}
                </ul>

                <div className="checklist-add">
                  <input
                    className="checklist-new-input"
                    value={newItem}
                    onChange={(e) => setNewItem(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submitItem()}
                    placeholder="添加条目，回车确认…"
                  />
                  <button className="btn btn-sm" onClick={submitItem}>
                    <IconPlus width={12} height={12} />
                    添加
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {confirmDel && (
        <ConfirmDialog
          title="删除清单"
          message={`确定删除清单「${confirmDel.title}」？此操作不可撤销。`}
          confirmText="删除"
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => {
            void remove(confirmDel.id);
            setConfirmDel(null);
          }}
        />
      )}
    </div>
  );
}

/** 应用内确认对话框（内联版：复用宿主 .confirm-overlay/.confirm-dialog class，照抄样板） */
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
window.__TB_PLUGIN_UI__["core-checklists"] = {
  mount(el, api) {
    root = createRoot(el);
    root.render(<ChecklistsPluginUi api={api} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
