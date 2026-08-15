import { useEffect, useState } from "react";
import { useChecklists } from "../core/checklists";
import { useVault } from "../core/vault";
import { useNav } from "../core/navigation";
import { onRowKeyDown } from "../core/keyboard";
import { IconFileText, IconPlus, IconTrash } from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 清单视图（M4）：左侧清单列表 + 右侧清单编辑器（打卡/进度/笔记关联）。
 */
export function ChecklistView() {
  const vault = useVault();
  const nav = useNav();
  const {
    metas,
    current,
    loading,
    refresh,
    open,
    create,
    remove,
    rename,
    addItem,
    toggleItem,
    removeItem,
    updateItem,
    setItemNote,
  } = useChecklists();

  const [newTitle, setNewTitle] = useState("");
  const [newItem, setNewItem] = useState("");
  const [pickingNote, setPickingNote] = useState<string | null>(null);
  const [noteQuery, setNoteQuery] = useState("");
  const [confirmDel, setConfirmDel] = useState<{ id: string; title: string } | null>(null);

  /* 从导航参数打开指定清单 */
  useEffect(() => {
    if (nav.params.openChecklistId) {
      void open(nav.params.openChecklistId);
      nav.go("checklist");
    }
  }, [nav.params.openChecklistId]); // eslint-disable-line react-hooks/exhaustive-deps

  const notes = vault.files.filter((f) => !f.isDir && f.path.toLowerCase().endsWith(".md"));

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

  const done = current?.items.filter((i) => i.done).length ?? 0;
  const total = current?.items.length ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="checklist-view">
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
              onKeyDown={(e) => onRowKeyDown(e, () => void open(m.id))}
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
                          vault.files.some((f) => f.path === item.note)
                            ? ""
                            : " broken"
                        }`}
                        onClick={() => nav.openNote(item.note!)}
                        title={
                          vault.files.some((f) => f.path === item.note)
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
                            {notes
                              .filter((n) => n.path.toLowerCase().includes(noteQuery.toLowerCase()))
                              .map((n) => (
                                <button
                                  key={n.path}
                                  className="note-picker-item"
                                  onClick={() => pickNote(item.id, n.path)}
                                >
                                  {n.path}
                                </button>
                              ))}
                            {notes.length === 0 && (
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
      <ConfirmDialog
        open={confirmDel !== null}
        title="删除清单"
        message={confirmDel ? `确定删除清单「${confirmDel.title}」？此操作不可撤销。` : ""}
        confirmText="删除"
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          if (confirmDel) void remove(confirmDel.id);
          setConfirmDel(null);
        }}
      />
    </div>
  );
}
