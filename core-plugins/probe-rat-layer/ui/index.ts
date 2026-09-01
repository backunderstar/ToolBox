// 探针卡分层插件自带前端入口（Vue 3）——process（Python）插件加界面的完整示例。
// 宿主 PluginUiView 读插件 ui/index.js（自包含 IIFE）→ 注入统一 api 桥 →
// 调用本文件的 mount(el, api) 挂载。界面里的按钮经 api.call 调 Python 命令
// （plugin_call → JSON-RPC over stdio），api.on 订阅插件推送的事件。
// 构建：pnpm build-external-ui plugins/probe-rat-layer → ui/index.js + style.css（gitignored）。
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
window.__TB_PLUGIN_UI__["probe-rat-layer"] = {
  mount(el, api) {
    app = createApp(App, { api });
    app.mount(el);
  },
  unmount() {
    app?.unmount();
    app = null;
  },
};
