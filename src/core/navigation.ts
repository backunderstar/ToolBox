import { reactive } from "vue";

/**
 * 跨视图导航（Vue 3 模块级单例 store）：视图切换。
 * 宿主内置视图 = 概览 / 插件 / 设置；业务视图由插件 nav 声明动态路由
 * （App 按 nav 表渲染该插件的自带前端），故视图 id 为任意字符串。
 */
export type ViewId = string;

const state = reactive<{ view: ViewId }>({ view: "overview" });

function go(view: ViewId): void {
  state.view = view;
}

export function useNav() {
  return { state, go };
}
