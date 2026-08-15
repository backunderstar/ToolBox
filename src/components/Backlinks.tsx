import { useMemo, useState } from "react";
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
    for (const [path, entries] of checklists.backlinks) {
      if (path === base || path.split("/").pop() === baseName) {
        for (const e of entries) {
          out.push({ type: "清单", title: e.title, id: e.checklistId });
        }
      }
    }
    for (const [path, entries] of records.backlinks) {
      if (path === base || path.split("/").pop() === baseName) {
        for (const e of entries) {
          out.push({ type: "记录", title: e.title, id: e.recordId });
        }
      }
    }
    return out;
  }, [activePath, checklists.backlinks, records.backlinks]);

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
