import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import App from "../ui/App.vue";
import { mockApi } from "./helpers";

/** App.vue 界面行为测试：api.call / api.on / api.context / host.search 全走 mock。 */
describe("App.vue（模板界面）", () => {
  it("渲染标题并显示宿主注入的工作区路径", () => {
    const { api } = mockApi();
    const w = mount(App, { props: { api } });
    expect(w.text()).toContain("我的插件");
    expect(w.text()).toContain("D:\\mock\\vault");
  });

  it("点击「打招呼」调用 api.call(\"hello\") 并显示返回值", async () => {
    const { api } = mockApi();
    const w = mount(App, { props: { api } });
    await w.find("button").trigger("click"); // 第一个按钮 = 打招呼
    await flushPromises();
    expect(api.call).toHaveBeenCalledWith("hello", { name: "世界" });
    expect(w.text()).toContain("你好，世界，来自 Python 插件！");
  });

  it("点击「列出 vault 内 Markdown」显示 api.call(\"fileList\") 的文件列表", async () => {
    const { api } = mockApi();
    const w = mount(App, { props: { api } });
    const btn = w.findAll("button").find((b) => b.text().includes("列出 vault 内 Markdown"));
    expect(btn).toBeDefined();
    await btn!.trigger("click");
    await flushPromises();
    expect(api.call).toHaveBeenCalledWith("fileList");
    expect(w.text()).toContain("notes/a.md");
    expect(w.text()).toContain("tasks/b.md");
  });

  it("api.on(\"progress\") 订阅：mock 宿主推送事件 → 事件流出现", async () => {
    const { api, emit } = mockApi();
    const w = mount(App, { props: { api } });
    expect(api.on).toHaveBeenCalledWith("progress", expect.any(Function));
    emit("progress", { percent: 60, message: "处理中…" });
    await flushPromises();
    expect(w.text()).toContain("progress 60%: 处理中…");
  });

  it("host.search：输入关键词点搜索 → 显示聚合结果", async () => {
    const { api } = mockApi();
    const w = mount(App, { props: { api } });
    const input = w.find("input");
    await input.setValue("示例");
    const btn = w.findAll("button").find((b) => b.text().trim() === "搜索");
    await btn!.trigger("click");
    await flushPromises();
    expect(api.host?.search).toHaveBeenCalledWith("示例");
    expect(w.text()).toContain("[py-tools] a.md");
    expect(w.text()).toContain("命中片段");
  });

  it("命令调用失败 → 显示错误条且不崩", async () => {
    const { api } = mockApi();
    vi.mocked(api.call).mockRejectedValueOnce(new Error("插件进程挂了"));
    const w = mount(App, { props: { api } });
    await w.find("button").trigger("click");
    await flushPromises();
    expect(w.text()).toContain("插件进程挂了");
  });
});
