// core-example 桌面浮窗入口（Vue 3）——教学点：manifest `float` 声明 = 浮窗界面。
// 宿主 FloatApp（label=float 的独立窗口）读插件 float 入口（ui/float.js）→ 注入
// 统一 api 桥 → 调用 mount(el, api) 挂载。注册 key = 插件 id（与主界面同机制；
// 浮窗是独立窗口，window 对象独立，与主界面注册不冲突）。
// 构建：build-core.mjs 支持 ui/float.ts → float.js（多入口）。
import { createApp, type App as VueApp } from "vue";
import FloatPanel from "./FloatPanel.vue";
import type { PluginBridgeApi } from "./bridge";

declare global {
  interface Window {
    __TB_PLUGIN_UI__?: Record<
      string,
      { mount: (el: HTMLElement, api: PluginBridgeApi) => void; unmount?: () => void }
    >;
  }
}

let app: VueApp | null = null;
window.__TB_PLUGIN_UI__ = window.__TB_PLUGIN_UI__ || {};
window.__TB_PLUGIN_UI__["core-example"] = {
  mount(el, api) {
    app = createApp(FloatPanel, { api });
    app.mount(el);
  },
  unmount() {
    app?.unmount();
    app = null;
  },
};
