import { useEffect, useMemo, useRef, useState } from "react";
import { useRecords } from "../core/records";
import type { RecordData } from "../core/records";
import { useVault } from "../core/vault";
import { useNav } from "../core/navigation";
import { onRowKeyDown } from "../core/keyboard";
import { IconFileText, IconPlus, IconTrash } from "./icons";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 记录视图（M4）：左侧记录列表（筛选/统计）+ 右侧编辑器（标题/日期/标签/正文）。
 * 正文支持 [[笔记路径]] 双向链接。
 */
export function RecordsView() {
  const nav = useNav();
  const vault = useVault();
  const { records, loading, create, save, remove, extractLinks } =
    useRecords();

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RecordData | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [tagText, setTagText] = useState("");

  const draftRef = useRef<RecordData | null>(null);
  draftRef.current = draft;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /* 从导航参数打开指定记录：数据未就绪时保留参数，等 records 加载后重试 */
  useEffect(() => {
    const id = nav.params.openRecordId;
    if (!id) return;
    const r = records.find((x) => x.id === id);
    if (!r) return; // 尚未加载完成，等待重试
    setCurrentId(id);
    setDraft({ ...r });
    setTagText(r.tags.join(", "));
    nav.go("records"); // 成功打开后才清空参数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.params.openRecordId, records]);

  const newRecord = async () => {
    await flush();
    const r = await create();
    if (r) {
      setCurrentId(r.id);
      setDraft({ ...r });
      setTagText("");
    }
  };

  const [confirmDel, setConfirmDel] = useState<{ id: string; title: string } | null>(null);

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
              onKeyDown={(e) => onRowKeyDown(e, () => openRecord(r.id))}
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
                  const broken = !vault.files.some(
                    (f) => f.path === `notes/${l.replace(/^notes\//, "")}`
                  );
                  return (
                    <button
                      key={l}
                      className={`note-link${broken ? " broken" : ""}`}
                      onClick={() => nav.openNote(l)}
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
      <ConfirmDialog
        open={confirmDel !== null}
        title="删除记录"
        message={confirmDel ? `确定删除记录「${confirmDel.title}」？此操作不可撤销。` : ""}
        confirmText="删除"
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          if (confirmDel) void deleteRecord(confirmDel.id);
          setConfirmDel(null);
        }}
      />
    </div>
  );
}
