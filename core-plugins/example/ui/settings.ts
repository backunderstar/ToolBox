// core-example 设置面板入口（教学点：宿主外壳扩展点——manifest settings.entry）。
// 与主界面同机制：自包含 IIFE，注册 key 约定 `settings:<pluginId>`，
// 宿主设置页「插件设置」段经 PluginUiView(regKey="settings:<pluginId>") 挂载。
import { createApp, type App as VueApp } from "vue";
import SettingsPanel from "./SettingsPanel.vue";
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
window.__TB_PLUGIN_UI__["settings:core-example"] = {
  mount(el, api) {
    app = createApp(SettingsPanel, { api });
    app.mount(el);
  },
  unmount() {
    app?.unmount();
    app = null;
  },
};
