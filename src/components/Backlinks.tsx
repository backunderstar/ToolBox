import { useEffect, useMemo, useState } from "react";
import { useChecklists } from "../core/checklists";
import { useRecords } from "../core/records";
import { useNav } from "../core/navigation";
import { IconChevronDown, IconLink } from "./icons";

/**
 * 笔记反链面板（M4）：显示引用当前笔记的清单条目与工作记录。
 * 精确路径或 basename 匹配，点击跳转到对应视图并打开。
 */
export function Backlinks({ activePath }: { activePath: string }) {
  const checklists = useChecklists();
  const records = useRecords();
  const nav = useNav();
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const base = activePath.replace(/^\/+/, "");
    const baseName = activePath.split("/").pop() ?? activePath;
    const out: { type: "清单" | "记录"; title: string; id: string }[] = [];
    // 精确路径匹配优先；仅当无精确匹配时回退 basename（避免同名笔记误报）
    const collect = (kind: "清单" | "记录", id: string, title: string) => {
      out.push({ type: kind, title, id });
    };
    let exact = 0;
    for (const [path, entries] of checklists.backlinks) {
      if (path === base) {
        for (const e of entries) collect("清单", e.checklistId, e.title);
        exact += entries.length;
      }
    }
    for (const [path, entries] of records.backlinks) {
      if (path === base) {
        for (const e of entries) collect("记录", e.recordId, e.title);
        exact += entries.length;
      }
    }
    if (exact === 0) {
      for (const [path, entries] of checklists.backlinks) {
        if (path.split("/").pop() === baseName) {
          for (const e of entries) collect("清单", e.checklistId, e.title);
        }
      }
      for (const [path, entries] of records.backlinks) {
        if (path.split("/").pop() === baseName) {
          for (const e of entries) collect("记录", e.recordId, e.title);
        }
      }
    }
    return out;
  }, [activePath, checklists.backlinks, records.backlinks]);

  /* 切换笔记时重置展开状态 */
  useEffect(() => {
    setOpen(false);
  }, [activePath]);

  if (matches.length === 0) return null;

  return (
    <div className="backlinks">
      <button className="backlinks-toggle" onClick={() => setOpen((o) => !o)}>
        <IconLink width={12} height={12} />
        <span>反向链接 {matches.length}</span>
        <IconChevronDown
          width={12}
          height={12}
          className={`backlinks-caret${open ? " flip" : ""}`}
        />
      </button>
      {open && (
        <div className="backlinks-list">
          {matches.map((m, i) => (
            <button
              key={`${m.type}-${m.id}-${i}`}
              className="backlink-item"
              onClick={() =>
                m.type === "清单" ? nav.openChecklist(m.id) : nav.openRecord(m.id)
              }
            >
              <span className={`backlink-type backlink-type-${m.type === "清单" ? "check" : "record"}`}>
                {m.type}
              </span>
              <span className="backlink-title">{m.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
