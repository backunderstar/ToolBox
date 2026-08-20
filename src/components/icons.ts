/**
 * 内联 SVG 图标库：统一 1.6 描边、圆头端点，随 currentColor 着色。
 * 不引入第三方图标库，保持包体轻量、风格统一（M5 主题系统可替换图标集）。
 *
 * Vue 版：原 React 组件函数（icons.tsx）改为「图标名 → 内部 path 片段」数据表，
 * 由 Icon.vue 统一渲染。数据为仓库内静态内容（无用户输入），v-html 安全。
 */
export const ICON_PATHS: Record<string, string> = {
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  "file-text":
    '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  check: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8.5 12.5l2.4 2.4 4.6-5.4"/>',
  sparkle:
    '<path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.4 2.5 2.4 13 0 16M12 4c-2.4 2.5-2.4 13 0 16"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
  moon: '<path d="M20 13.2A8 8 0 1 1 10.8 4a6.4 6.4 0 0 0 9.2 9.2z"/>',
  folder: '<path d="M3.5 6.5h6l2 2.5h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  "chevron-right": '<path d="M9 6l6 6-6 6"/>',
  "panel-left": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  "chevron-down": '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash:
    '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12"/><path d="M10 11v6M14 11v6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>',
  puzzle:
    '<path d="M9 4h6v3.2a1.6 1.6 0 0 0 3.2 0V4h2v5.2a1.6 1.6 0 0 0 3.2 0V4a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v2.2h1.6A1.6 1.6 0 0 1 9 7.8Z"/><path d="M7 6H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3h-2.2a1.6 1.6 0 0 1 0-3.2H20v-2"/>',
  "arrow-up": '<path d="M12 19V5M6 11l6-6 6 6"/>',
  "arrow-down": '<path d="M12 5v14M6 13l6 6 6-6"/>',
  float: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 8h.01M10 8h.01"/>',
};

/** 可选图标名（NavSettings 图标下拉用） */
export const ICON_NAMES = Object.keys(ICON_PATHS);

/** 未知图标名的兜底（原 Sidebar 默认 IconGrid） */
export const FALLBACK_ICON = "grid";
