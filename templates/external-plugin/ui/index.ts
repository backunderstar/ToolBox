// 插件自带前端入口：宿主 PluginUiView 读插件 ui/index.js（自包含 IIFE）→ 注入
// 统一 api 桥 → 调用本文件的 mount(el, api) 挂载。界面里 api.call 调 Python 命令、
// api.on 订阅事件。构建：npm run build → ui/index.js + style.css（生成物，勿手改）。
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
window.__TB_PLUGIN_UI__["my-plugin"] = {
  mount(el, api) {
    app = createApp(App, { api });
    app.mount(el);
  },
  unmount() {
    app?.unmount();
    app = null;
  },
};
