import { describe, expect, it } from "vitest";
import type { PluginBridgeApi } from "../ui/bridge";
import { mockApi } from "./helpers";

/** 自带前端入口契约：window.__TB_PLUGIN_UI__[id] = { mount(el, api), unmount() }。
 * 宿主 PluginUiView 按此契约注入 api 并挂载（真实宿主见 ToolBox src/components/PluginUiView.vue）。 */
describe("ui/index.ts（自带前端入口）", () => {
  it("import 后注册 __TB_PLUGIN_UI__[\"my-plugin\"]，mount 渲染、unmount 清空", async () => {
    await import("../ui/index");

    const w = window as unknown as {
      __TB_PLUGIN_UI__?: Record<
        string,
        { mount: (el: HTMLElement, api: PluginBridgeApi) => void; unmount?: () => void }
      >;
    };
    const entry = w.__TB_PLUGIN_UI__?.["my-plugin"];
    expect(entry, "应注册 my-plugin 入口").toBeDefined();

    const el = document.createElement("div");
    document.body.appendChild(el);
    const { api } = mockApi();
    entry!.mount(el, api);
    expect(el.textContent).toContain("我的插件");

    entry!.unmount?.();
    expect(el.innerHTML).toBe("");
    document.body.removeChild(el);
  });
});
