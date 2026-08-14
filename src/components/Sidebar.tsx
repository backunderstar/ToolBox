import {
  IconCheckSquare,
  IconFileText,
  IconGear,
  IconGlobe,
  IconGrid,
  IconNotebook,
  IconSliders,
  IconSparkle,
} from "./icons";
import type { ComponentType, SVGProps } from "react";

interface NavItem {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  milestone?: string; // 规划中的里程碑，缺省表示可用
  now?: boolean; // 当前骨架已具备
}

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "工作区",
    items: [
      { id: "overview", label: "概览", icon: IconGrid, now: true },
      { id: "notes", label: "笔记", icon: IconFileText, milestone: "M1" },
      { id: "tools", label: "数据工具", icon: IconSliders, milestone: "M3" },
      { id: "checklist", label: "清单", icon: IconCheckSquare, milestone: "M4" },
      { id: "records", label: "记录", icon: IconNotebook, milestone: "M4" },
    ],
  },
  {
    label: "系统",
    items: [
      { id: "ai", label: "AI 整理", icon: IconSparkle, milestone: "M6" },
      { id: "blog", label: "博客发布", icon: IconGlobe, milestone: "M7" },
      { id: "settings", label: "设置", icon: IconGear, milestone: "M1" },
    ],
  },
];

const ACTIVE = "overview";

export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="主导航">
      {GROUPS.map((group) => (
        <div className="nav-group" key={group.label}>
          <div className="nav-label">{group.label}</div>
          {group.items.map((item) => {
            const Icon = item.icon;
            const isActive = item.id === ACTIVE;
            return (
              <button
                key={item.id}
                className={`nav-item${isActive ? " active" : ""}`}
                disabled={!item.now && !isActive}
                title={
                  item.milestone
                    ? `规划于 ${item.milestone} 里程碑`
                    : item.label
                }
              >
                <Icon width={16} height={16} />
                <span>{item.label}</span>
                {item.now ? (
                  <span className="nav-badge badge-now">就绪</span>
                ) : item.milestone ? (
                  <span className="nav-badge badge-plan">{item.milestone}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
