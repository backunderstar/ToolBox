import {
  IconCheckSquare,
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconGear,
  IconGlobe,
  IconGrid,
  IconPuzzle,
  IconSparkle,
} from "./icons";
import type { ComponentType, SVGProps } from "react";
import type { NavConfig, NavItemDef } from "../core/navPrefs";

export type ViewId =
  | "overview"
  | "notes"
  | "plugins"
  | "checklist"
  | "projects"
  | "ai"
  | "blog"
  | "settings";

/** 插件 nav 图标名 → 组件映射（与 navPrefs 的图标名一致，供 meta.icon 覆盖）。 */
export const ICON_MAP: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  "file-text": IconFileText,
  grid: IconGrid,
  check: IconCheckSquare,
  folder: IconFolder,
  sparkle: IconSparkle,
  globe: IconGlobe,
  gear: IconGear,
  puzzle: IconPuzzle,
};

/** 可选图标名（NavSettings 图标下拉用） */
export const ICON_NAMES = Object.keys(ICON_MAP);

interface SidebarProps {
  activeView: ViewId;
  onSelect: (view: ViewId) => void;
  /** 侧边栏整体折叠（窄模式，仅图标） */
  collapsed: boolean;
  /** 归一化后的导航配置（分组 + 项顺序 + 元数据覆盖） */
  config: NavConfig;
  /** 全部项定义（静态 + 插件 nav 声明） */
  defs: NavItemDef[];
  /** 切换分组折叠（记忆） */
  onToggleGroup: (groupId: string) => void;
}

export function Sidebar({
  activeView,
  onSelect,
  collapsed,
  config,
  defs,
  onToggleGroup,
}: SidebarProps) {
  const defById = new Map(defs.map((d) => [d.id, d]));

  return (
    <nav className={`sidebar${collapsed ? " collapsed" : ""}`} aria-label="主导航">
      {config.groups.map((group) => {
        const items = (config.order[group.id] ?? [])
          .map((id) => {
            const def = defById.get(id);
            if (!def) return null;
            if (config.meta[id]?.hidden) return null;
            const meta = config.meta[id];
            const label = meta?.label ?? def.label;
            const Icon = ICON_MAP[meta?.icon ?? def.icon] ?? IconGrid;
            return { id, label, Icon };
          })
          .filter(
            (x): x is { id: string; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> } =>
              !!x,
          );
        if (items.length === 0) return null;
        const groupCollapsed = !!group.collapsed;

        return (
          <div className="nav-group" key={group.id}>
            {!collapsed && (
              <button
                className="nav-group-head"
                onClick={() => onToggleGroup(group.id)}
                title={groupCollapsed ? `展开「${group.label}」` : `折叠「${group.label}」`}
              >
                <span className="nav-label">{group.label}</span>
                <span className="nav-group-caret">
                  {groupCollapsed ? (
                    <IconChevronRight width={11} height={11} />
                  ) : (
                    <IconChevronDown width={11} height={11} />
                  )}
                </span>
              </button>
            )}
            {!groupCollapsed &&
              items.map((item) => {
                const Icon = item.Icon;
                const isActive = item.id === activeView;
                return (
                  <button
                    key={item.id}
                    className={`nav-item${isActive ? " active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                    title={item.label}
                    onClick={() => onSelect(item.id as ViewId)}
                  >
                    <Icon width={16} height={16} />
                    {!collapsed && <span>{item.label}</span>}
                  </button>
                );
              })}
          </div>
        );
      })}
    </nav>
  );
}
