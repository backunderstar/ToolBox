import { beforeAll, describe, expect, it } from "vitest";
import type { PluginInfo } from "./api";

/**
 * plugins store 测试（mock 模式，不依赖 Tauri / 文件系统）：
 * - 模块级 watch(refresh, immediate) 与 vault.ts 的 window.addEventListener
 *   在导入时执行——node 环境无 window，必须先装好全局 mock 再**动态 import**
 *   （静态 import 会先于赋值执行，导致 ReferenceError）。
 * - mock 模式（?mock）下 refresh 走内存注册表，可完整验证命令注册/调用/
 *   校验/导航投影逻辑，无需打桩 IPC。
 */
const windowMock = {
  location: { search: "" },
  addEventListener: () => {},
} as unknown as Window & typeof globalThis;
(globalThis as unknown as Record<string, unknown>).window = windowMock;

type PluginsModule = typeof import("./plugins");
let plugins: PluginsModule;

beforeAll(async () => {
  plugins = await import("./plugins");
});

/** 构造完整 PluginInfo（缺省合理值，按需覆盖） */
function mkPlugin(overrides: Partial<PluginInfo>): PluginInfo {
  return {
    id: "p",
    name: "P",
    version: "0.1.0",
    description: "",
    runtime: "process",
    entry: null,
    enabled: true,
    status: "ready",
    error: null,
    commands: [],
    builtin: false,
    provider: false,
    system: false,
    ui: null,
    nav: [],
    theme: null,
    hasDeps: false,
    actions: [],
    settings: null,
    float: null,
    ...overrides,
  };
}

function mockMode(on: boolean): void {
  (windowMock.location as { search: string }).search = on ? "?mock" : "";
}

describe("plugins store（mock 模式）", () => {
  it("refresh 填充 mock 清单，入口声明（ui/settings/float）透传", async () => {
    mockMode(true);
    const { state, refresh, navItems } = plugins.usePlugins();
    await refresh();
    expect(state.plugins).toHaveLength(1);
    expect(state.plugins[0].id).toBe("core-example");
    expect(state.plugins[0].ui).toBe("ui/index.js");
    expect(state.plugins[0].settings).toBe("ui/settings.js");
    expect(state.plugins[0].float).toBe("ui/float.js"); // 浮窗入口声明
    expect(state.runtimeErrors).toEqual({});
    // 启用插件的 nav 并入导航（pluginId 补齐）
    expect(navItems.value).toEqual([
      expect.objectContaining({ id: "example", pluginId: "core-example" }),
    ]);
  });

  it("invoke：mock 模式走注册表内联实现（含参数校验）", async () => {
    mockMode(true);
    const { refresh, invoke, commandsOf } = plugins.usePlugins();
    await refresh();
    const before = (await invoke("core-example", "example.list", {})) as unknown[];
    expect(before).toEqual([]);
    const after = (await invoke("core-example", "example.add", {
      text: "第一条",
    })) as { id: string; text: string; done: boolean }[];
    expect(after).toHaveLength(1);
    expect(after[0].text).toBe("第一条");
    expect(after[0].done).toBe(false);
    // 空内容被校验拦截
    await expect(
      invoke("core-example", "example.add", { text: "   " }),
    ).rejects.toThrow("条目内容为空");
    // toggle 翻转 done
    const toggled = (await invoke("core-example", "example.toggle", {
      id: after[0].id,
    })) as { done: boolean }[];
    expect(toggled[0].done).toBe(true);
    // 命令注册表内容
    expect(commandsOf("core-example").map((c) => c.id)).toEqual([
      "example.list",
      "example.add",
      "example.toggle",
      "example.delete",
    ]);
  });

  it("invoke：未知插件 / 未注册命令报可读错误", async () => {
    mockMode(true);
    const { refresh, invoke } = plugins.usePlugins();
    await refresh();
    await expect(invoke("ghost", "x", {})).rejects.toThrow("插件不存在");
    await expect(invoke("core-example", "nope", {})).rejects.toThrow("命令未注册");
  });

  it("webview 插件：注册表为空时同样报「命令未注册」", async () => {
    mockMode(false);
    const { state, invoke } = plugins.usePlugins();
    state.plugins = [
      mkPlugin({ id: "web-demo", runtime: "webview", enabled: true, commands: ["declared"] }),
    ];
    // 声明命令 ≠ 已注册实现：未加载入口前调用报错（而非静默）
    await expect(invoke("web-demo", "declared", {})).rejects.toThrow("命令未注册");
  });

  it("导航投影：禁用插件不产生 nav；声明 nav 的启用插件并入", () => {
    mockMode(false);
    const { state, navItems } = plugins.usePlugins();
    state.plugins = [
      mkPlugin({
        id: "a",
        enabled: true,
        nav: [{ id: "va", label: "A", icon: "a", group: "工作区", pluginId: "a" }],
      }),
      mkPlugin({
        id: "b",
        enabled: false,
        nav: [{ id: "vb", label: "B", icon: "b", group: "工作区", pluginId: "b" }],
      }),
    ];
    expect(navItems.value.map((n) => n.id)).toEqual(["va"]);
  });

  it("主题投影：启用且声明 theme 的插件进入 pluginThemeKey", () => {
    mockMode(false);
    const { state, pluginThemeKey } = plugins.usePlugins();
    state.plugins = [
      mkPlugin({
        id: "theme-x",
        enabled: true,
        theme: { base: "dark", tokens: { "--bg": "#111" }, css: null, preview: null },
      }),
      mkPlugin({ id: "no-theme", enabled: true }),
      mkPlugin({
        id: "theme-disabled",
        enabled: false,
        theme: { base: "light", tokens: {}, css: null, preview: null },
      }),
    ];
    expect(pluginThemeKey.value).toBe("theme-x");
  });
});
