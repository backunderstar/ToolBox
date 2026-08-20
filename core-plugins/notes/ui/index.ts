// core-notes 插件自带前端入口（Vue 3）：
// 自包含 IIFE 注册到宿主注册表，宿主 PluginUiView 挂载时调用。
// 构建：Vite lib 模式（plugin-ui-build.mjs，vue 插件）→ index.js + style.css。
import { createApp, type App as VueApp } from "vue";
import App from "./App.vue";
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
window.__TB_PLUGIN_UI__["core-notes"] = {
  mount(el, api) {
    app = createApp(App, { api });
    app.mount(el);
  },
  unmount() {
    app?.unmount();
    app = null;
  },
};
