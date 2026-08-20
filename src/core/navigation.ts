import { reactive } from "vue";

/**
 * 跨视图导航（Vue 3 模块级单例 store）：
 * 视图切换 + 打开具体条目（笔记/清单）。
 * 原 React 版值由 AppInner 用 useMemo 构造经 context 下发；
 * Vue 版为模块级单例，任何组件直接经 useNav() 读取/调用。
 */

/** 宿主导航的视图联合类型（插件视图 id 为字符串，App 按 nav 表动态路由） */
export type ViewId =
  | "overview"
  | "notes"
  | "plugins"
  | "checklist"
  | "projects"
  | "ai"
  | "blog"
  | "settings";

const state = reactive<{ view: ViewId }>({ view: "overview" });

function go(view: ViewId): void {
  state.view = view;
}

/** 打开笔记（切到笔记视图并打开文件；宿主不再调 openFile 二次读盘——笔记
 *  界面是插件自带前端，经 __TB_PENDING_NOTE__ + tb:open-note 事件驱动插件打开） */
function openNote(rel: string): void {
  state.view = "notes";
  (window as unknown as Record<string, unknown>).__TB_PENDING_NOTE__ = rel;
  window.dispatchEvent(new CustomEvent("tb:open-note", { detail: rel }));
}

/** 打开清单（切到清单视图；具体清单 id 经 tb:open-checklist 事件广播，宿主不持有） */
function openChecklist(): void {
  state.view = "checklist";
}

export function useNav() {
  return { state, go, openNote, openChecklist };
}
