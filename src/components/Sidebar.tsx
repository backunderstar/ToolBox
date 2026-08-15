import {
  IconCheckSquare,
  IconFileText,
  IconFolder,
  IconGear,
  IconGlobe,
  IconGrid,
  IconNotebook,
  IconPuzzle,
  IconSliders,
  IconSparkle,
} from "./icons";
import type { ComponentType, SVGProps } from "react";
import type { NavPrefs } from "../core/navPrefs";

export type ViewId =
  | "overview"
  | "notes"
  | "plugins"
  | "tools"
  | "checklist"
  | "records"
  | "projects"
  | "ai"
  | "blog"
  | "settings";

export interface NavItem {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  milestone?: string; // 规划中的里程碑，缺省表示可用
  now?: boolean; // 当前已实现
}

/** 导航分组定义（设置页的"导航栏"配置也基于它渲染）。 */
export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "工作区",
    items: [
      { id: "overview", label: "概览", icon: IconGrid, now: true },
      { id: "notes", label: "笔记", icon: IconFileText, now: true },
      { id: "plugins", label: "插件", icon: IconPuzzle, now: true },
      { id: "tools", label: "数据工具", icon: IconSliders, now: true },
      { id: "checklist", label: "清单", icon: IconCheckSquare, now: true },
      { id: "records", label: "记录", icon: IconNotebook, now: true },
      { id: "projects", label: "项目", icon: IconFolder, now: true },
    ],
  },
  {
    label: "系统",
    items: [
      { id: "ai", label: "AI 整理", icon: IconSparkle, now: true },
      { id: "blog", label: "博客发布", icon: IconGlobe, now: true },
      { id: "settings", label: "设置", icon: IconGear, now: true },
    ],
  },
];

interface SidebarProps {
  activeView: ViewId;
  onSelect: (view: ViewId) => void;
  collapsed: boolean;
  /** 导航偏好（顺序 + 隐藏）；由 App 从 localStorage 加载并持久化 */
  prefs: NavPrefs;
}

export function Sidebar({ activeView, onSelect, collapsed, prefs }: SidebarProps) {
  return (
    <nav
      className={`sidebar${collapsed ? " collapsed" : ""}`}
      aria-label="主导航"
    >
      {NAV_GROUPS.map((group) => {
        // 按偏好顺序渲染；隐藏项剔除（settings 由 normalize 保证永远可见）
        const order = prefs.order[group.label] ?? group.items.map((i) => i.id);
        const items = order
          .map((id) => group.items.find((i) => i.id === id))
          .filter((i): i is NavItem => !!i)
          .filter((i) => !prefs.hidden.includes(i.id));
        return (
          <div className="nav-group" key={group.label}>
            {!collapsed && <div className="nav-label">{group.label}</div>}
            {items.map((item) => {
              const Icon = item.icon;
              const isActive = item.id === activeView;
              const isClickable =
                item.id === "overview" ||
                item.id === "notes" ||
                item.id === "plugins" ||
                item.id === "tools" ||
                item.id === "checklist" ||
                item.id === "records" ||
                item.id === "projects" ||
                item.id === "ai" ||
                item.id === "blog" ||
                item.id === "settings";
              return (
                <button
                  key={item.id}
                  className={`nav-item${isActive ? " active" : ""}`}
                  disabled={!isClickable}
                  title={
                    item.milestone
                      ? `${item.label}（规划于 ${item.milestone} 里程碑）`
                      : item.label
                  }
                  onClick={() => onSelect(item.id as ViewId)}
                >
                  <Icon width={16} height={16} />
                  {!collapsed && <span>{item.label}</span>}
                  {!collapsed &&
                    (item.now ? (
                      <span className="nav-badge badge-now">就绪</span>
                    ) : item.milestone ? (
                      <span className="nav-badge badge-plan">{item.milestone}</span>
                    ) : null)}
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
