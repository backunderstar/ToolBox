import { reactive, watch, computed } from "vue";
import {
  fsRead,
  fsWrite,
  pluginCall,
  pluginsInvoke,
  pluginsList,
  pluginsReadFile,
  pluginsReload,
  pluginsSetEnabled,
  pluginsUninstall,
} from "./api";
import type { PluginInfo, PluginNav } from "./api";
import {
  buildBridgeApi,
  injectPluginScript,
  registerLocalCommand,
  clearLocalCommands,
  pruneLocalCommands,
  type PluginBridgeApi,
} from "./pluginRuntime";
import { vaultState } from "./vault";
import { setPluginThemes, type ThemeDef } from "../themes/themes";

/**
 * 插件系统（M2）——Vue 3 模块级单例 store。
 *
 * - 清单发现与启用状态由 Rust 核心管理（plugins_list / set_enabled / reload）
 * - webview 插件：前端读取入口 JS，经 **Blob URL `<script>` 注入**执行
 *   （CSP script-src blob: 允许；不能用 new Function——打包版 CSP 拦截 eval），
 *   插件通过 api.app.registerCommand 把命令注册进本地注册表
 * - process 插件：命令经 plugins_invoke 走 JSON-RPC 桥（Python 子进程）
 *
 * 与 React 版对应关系：useState → reactive 字段；useRef(runtimes) → 模块级
 * Map；useEffect(刷新) → watch(vaultState.path, immediate)；setPluginThemes
 * 的 effect → watch(pluginThemes)。
 */

export interface PluginCommand {
  id: string;
  name: string;
  run: (args: unknown) => unknown | Promise<unknown>;
}

export interface PluginApi {
  app: {
    registerCommand: (cmd: PluginCommand) => void;
  };
  fs: {
    /** 读工作区内文件（vault 相对路径） */
    readText: (path: string) => Promise<string>;
    /** 写工作区内文件（vault 相对路径） */
    writeText: (path: string, content: string) => Promise<void>;
  };
  events: {
    on: (event: string, cb: (data: unknown) => void) => () => void;
    emit: (event: string, data?: unknown) => void;
  };
  log: (...args: unknown[]) => void;
  /** 统一桥：调用插件命令（默认本插件，可跨插件） */
  call: PluginBridgeApi["call"];
  /** 统一桥：订阅本插件的 plugin-event */
  on: PluginBridgeApi["on"];
  /** 统一桥：当前工作区上下文 */
  context: PluginBridgeApi["context"];
}

const isMock = () => new URLSearchParams(window.location.search).has("mock");

const state = reactive({
  plugins: [] as PluginInfo[],
  loading: false,
  /** 插件加载/运行错误（含 webview 入口求值失败） */
  runtimeErrors: {} as Record<string, string>,
});

/** 单个插件的命令注册表 + 事件中心 */
interface PluginRuntime {
  commands: Map<string, PluginCommand>;
  listeners: Map<string, Set<(data: unknown) => void>>;
}

/** 各插件运行时（命令/事件注册表）；模块级生命周期，不随组件卸载 */
const runtimes = new Map<string, PluginRuntime>();
// 刷新请求序号：丢弃过期响应（快速连续 setEnabled/reload/uninstall 触发并发
// refresh 时，较慢的旧列表不得覆盖较新的结果）
let refreshSeq = 0;

function getRuntime(pluginId: string): PluginRuntime {
  let rt = runtimes.get(pluginId);
  if (!rt) {
    rt = { commands: new Map(), listeners: new Map() };
    runtimes.set(pluginId, rt);
  }
  return rt;
}

/** 构造传给 webview 插件入口的 api 对象 */
function buildApi(pluginId: string): PluginApi {
  const rt = getRuntime(pluginId);
  const vaultPath = () => vaultState.path;
  // 统一桥（与核心插件自带前端同构）：call → plugin_call / on → plugin-event
  const bridge = buildBridgeApi(pluginId, vaultPath);
  return {
    app: {
      registerCommand: (cmd) => {
        if (!cmd?.id || typeof cmd.run !== "function") {
          console.error(`[plugin:${pluginId}] registerCommand 参数非法`);
          return;
        }
        rt.commands.set(cmd.id, cmd);
        // 同步写入共享本地注册表：插件自带前端 UI 经 api.call 也能调本命令
        registerLocalCommand(pluginId, cmd.id, (args) => cmd.run(args));
      },
    },
    fs: {
      readText: async (path) => {
        const p = vaultPath();
        if (!p) throw new Error("工作区未设置");
        return fsRead(p, path);
      },
      writeText: async (path, content) => {
        const p = vaultPath();
        if (!p) throw new Error("工作区未设置");
        await fsWrite(p, path, content);
      },
    },
    events: {
      on: (event, cb) => {
        let set = rt.listeners.get(event);
        if (!set) {
          set = new Set();
          rt.listeners.set(event, set);
        }
        set.add(cb);
        return () => set!.delete(cb);
      },
      emit: (event, data) => {
        const set = rt.listeners.get(event);
        if (set) set.forEach((cb) => void cb(data));
      },
    },
    log: (...args) => {
      console.log(`[plugin:${pluginId}]`, ...args);
      // 同步落盘宿主运行日志（webview 插件 info 级；来源 [plugin:<id>]）
      bridge.log("info", args.map(String).join(" "));
    },
    call: bridge.call,
    on: bridge.on,
    context: bridge.context,
  };
}

/** 加载并求值一个 webview 插件入口（注册其命令） */
async function loadWebviewPlugin(plugin: PluginInfo): Promise<void> {
  if (plugin.runtime !== "webview" || !plugin.entry) return;
  const rt = getRuntime(plugin.id);
  // 重载时清空命令与事件监听，避免旧回调残留/重复注册
  rt.commands.clear();
  rt.listeners.clear();
  clearLocalCommands(plugin.id);
  try {
    // 插件装在全局目录（%APPDATA%/com.toolbox.desktop/plugins/），
    // 由 Rust 侧限定在插件目录内读取入口文件。
    // 用 Blob URL <script> 注入执行（公共加载器，CSP script-src blob: 允许），
    // 而非 new Function：打包版 CSP 会拦截 eval / Function 构造器。
    const code = await pluginsReadFile(plugin.id, plugin.entry);
    const w = window as unknown as Record<string, unknown>;
    const apiKey = `__TB_PLUGIN_API_${plugin.id}__`;
    w[apiKey] = buildApi(plugin.id);
    const wrapped = [
      "(function (api) {",
      "  try {",
      code,
      "  } catch (e) {",
      "    window.__TB_PLUGIN_ERROR__ = String((e && e.stack) || e);",
      "  }",
      `})(window[${JSON.stringify(apiKey)}]);`,
    ].join("\n");
    try {
      await injectPluginScript(wrapped);
      const err = w.__TB_PLUGIN_ERROR__;
      delete w.__TB_PLUGIN_ERROR__;
      if (typeof err === "string") throw new Error(err);
    } finally {
      // 无论成功/失败都清理句柄，防泄漏
      delete w[apiKey];
      delete w.__TB_PLUGIN_ERROR__;
    }
    const next = { ...state.runtimeErrors };
    delete next[plugin.id];
    state.runtimeErrors = next;
  } catch (e) {
    state.runtimeErrors = {
      ...state.runtimeErrors,
      [plugin.id]: String(e),
    };
    console.error(`[plugin:${plugin.id}] 入口加载失败`, e);
  }
}

/** 浏览器演示模式的示例插件清单（不经过 Rust / 文件系统）：教学基线 = 一个核心示例插件 */
const MOCK_PLUGINS: PluginInfo[] = [
  {
    id: "core-example",
    name: "示例插件",
    version: "0.1.0",
    description: "核心插件教学示例：命令/事件/搜索提供者/宿主能力/自带前端全覆盖",
    runtime: "native",
    entry: null,
    enabled: true,
    status: "ready",
    error: null,
    commands: ["example.list", "example.add", "example.toggle", "example.delete"],
    builtin: true,
    provider: true,
    system: false,
    ui: "ui/index.js",
    nav: [
      { id: "example", label: "示例插件", icon: "puzzle", group: "工作区", pluginId: "core-example" },
    ],
    theme: null,
    hasDeps: false,
    actions: [
      { id: "greet", label: "示例问候", icon: "puzzle", topbar: true, tray: true, file: false },
      { id: "open", label: "打开示例界面", icon: "file-text", topbar: false, tray: true, file: false },
    ],
    settings: "ui/settings.js",
    float: "ui/float.js",
  },
];

/** 重新发现插件 + 加载所有已启用 webview 插件的命令 */
async function refresh(): Promise<void> {
  if (isMock()) {
    state.plugins = MOCK_PLUGINS;
    // 浏览器演示：给 core-example 注册内联命令实现（内存列表，模拟后端）
    const rt = getRuntime("core-example");
    rt.commands.clear();
    const mockItems: { id: string; text: string; done: boolean; createdAt: string }[] = [];
    let seq = 0;
    const listVal = () => mockItems;
    rt.commands.set("example.list", {
      id: "example.list",
      name: "示例列表",
      run: async () => listVal(),
    });
    rt.commands.set("example.add", {
      id: "example.add",
      name: "示例添加",
      run: async (args) => {
        const text = String((args as { text?: unknown })?.text ?? "").trim();
        if (!text) throw new Error("条目内容为空");
        mockItems.push({ id: `e-${++seq}`, text, done: false, createdAt: new Date().toISOString() });
        return listVal();
      },
    });
    rt.commands.set("example.toggle", {
      id: "example.toggle",
      name: "示例切换",
      run: async (args) => {
        const id = String((args as { id?: unknown })?.id ?? "");
        const it = mockItems.find((i) => i.id === id);
        if (it) it.done = !it.done;
        return listVal();
      },
    });
    rt.commands.set("example.delete", {
      id: "example.delete",
      name: "示例删除",
      run: async (args) => {
        const id = String((args as { id?: unknown })?.id ?? "");
        const idx = mockItems.findIndex((i) => i.id === id);
        if (idx >= 0) mockItems.splice(idx, 1);
        return listVal();
      },
    });
    state.runtimeErrors = {};
    return;
  }
  // 插件管理是全局操作：不依赖工作区（列表/启停/安装/卸载与工作区无关，
  // 2026-09 用户反馈"没有工作区时没法管理插件"——已解耦）
  state.loading = true;
  const seq = ++refreshSeq;
  try {
    const list = await pluginsList();
    if (seq !== refreshSeq) return; // 过期响应丢弃
    state.plugins = list;
    // 重置所有注册表（保留运行时对象，只清命令）
    for (const rt of runtimes.values()) rt.commands.clear();
    // 清理已禁用/卸载插件的本地命令注册（它们不再走 loadWebviewPlugin，
    // 不清则 api.call 会命中过期注册执行旧插件代码）
    pruneLocalCommands(
      new Set(list.filter((pl) => pl.enabled && pl.runtime === "webview").map((pl) => pl.id)),
    );
    state.runtimeErrors = {};
    await Promise.all(
      list.filter((pl) => pl.enabled && pl.runtime === "webview").map((pl) => loadWebviewPlugin(pl)),
    );
    // 通知 Rust 重建托盘插件菜单（插件列表变化时）
    void import("@tauri-apps/api/event").then((m) => m.emit("plugins-changed", null)).catch(() => undefined);
  } catch (e) {
    if (seq === refreshSeq) {
      console.error("[plugins] 刷新失败", e);
    }
  } finally {
    if (seq === refreshSeq) state.loading = false;
  }
}

async function setEnabled(id: string, enabled: boolean): Promise<void> {
  if (!isMock()) {
    await pluginsSetEnabled(id, enabled);
  }
  await refresh();
}

async function reload(id: string): Promise<void> {
  if (!isMock()) {
    await pluginsReload(id);
  }
  await refresh();
}

async function uninstall(id: string): Promise<void> {
  await pluginsUninstall(id); // 停进程 + 清状态 + 删目录（回收站）
  await refresh();
}

/**
 * 触发插件外壳动作（顶栏按钮 / 托盘项 / 文件上下文动作）——统一交互契约：
 * ① 发 `plugin-event` 事件 `action`（payload {action, source, files?}）→ 插件自带前端
 *    UI 用 api.on("action") 订阅响应（webview / native 插件 UI 均可）
 * ② 插件非 webview 时调约定命令 `plugin.action {action, source, files?}`（native/process
 *    逻辑响应；未实现该命令则忽略——事件通道已发出）
 * source = topbar | tray | settings | file，插件可按来源区分行为；
 * source = "file" 时 files 为文件视图选中的工作区相对路径列表。
 */
export async function triggerPluginAction(
  pluginId: string,
  action: string,
  source: "topbar" | "tray" | "settings" | "file",
  files?: string[],
): Promise<void> {
  const p = vaultState.path;
  const data = files?.length ? { action, source, files } : { action, source };
  // ① 事件通道（插件 UI 订阅）
  void import("@tauri-apps/api/event")
    .then((m) => m.emit("plugin-event", { pluginId, event: "action", data }))
    .catch(() => undefined);
  // ② 命令通道（webview 插件命令在宿主侧无分发，跳过）
  const pl = state.plugins.find((x) => x.id === pluginId);
  if (!pl || pl.runtime === "webview" || !p) return;
  try {
    await pluginCall(p, pluginId, "plugin.action", data);
  } catch {
    /* 插件未实现 plugin.action：忽略（事件通道已发出） */
  }
}

async function invoke(pluginId: string, command: string, args: unknown): Promise<unknown> {
  const plugin = state.plugins.find((pl) => pl.id === pluginId);
  if (!plugin) throw new Error(`插件不存在: ${pluginId}`);
  // mock 模式下所有插件（含 process/native）都走注册表内联实现；
  // 真实模式下 webview 走注册表、process/native 走 IPC 桥
  if (isMock() || plugin.runtime === "webview") {
    const cmd = getRuntime(pluginId).commands.get(command);
    if (!cmd) throw new Error(`命令未注册: ${command}`);
    return cmd.run(args);
  }
  const p = vaultState.path;
  if (!p) throw new Error("工作区未设置");
  return plugin.runtime === "native"
    ? pluginCall(p, pluginId, command, args)
    : pluginsInvoke(p, pluginId, command, args);
}

function commandsOf(pluginId: string): { id: string; name: string }[] {
  const plugin = state.plugins.find((pl) => pl.id === pluginId);
  if (!plugin) return [];
  if (plugin.runtime === "webview") {
    return [...getRuntime(pluginId).commands.values()].map((c) => ({
      id: c.id,
      name: c.name,
    }));
  }
  return plugin.commands.map((c) => ({ id: c, name: c }));
}

/* 启用插件的导航入口（任何启用的插件都可声明 nav 并入侧边栏；
   核心插件与外部插件一视同仁）。pluginId 由这里补充——App 路由按
   nav.id 匹配后据此渲染对应插件的自带前端（PluginUiView）。 */
const navItems = computed<PluginNav[]>(() => {
  const out: PluginNav[] = [];
  for (const pl of state.plugins) {
    if (pl.enabled) {
      for (const n of pl.nav) out.push({ ...n, pluginId: pl.id });
    }
  }
  return out;
});

/* 皮肤插件 → 主题定义投影：启用且声明 theme 的插件并入主题引擎注册表
   （setPluginThemes），设置页主题选择器即可看到；应用时走"令牌 + CSS 双通道"
   （themes.ts applyTheme）。纯数据投影：不注入脚本、不启动任何运行时。 */
const pluginThemes = computed<ThemeDef[]>(() => {
  const out: ThemeDef[] = [];
  for (const pl of state.plugins) {
    if (pl.enabled && pl.theme) {
      out.push({
        id: pl.id, // 主题 id = 插件 id（插件 id 全局唯一，天然不冲突）
        name: pl.name,
        description: pl.description || "插件主题",
        base: pl.theme.base,
        tokens: pl.theme.tokens ?? {},
        css: pl.theme.css,
        preview: pl.theme.preview ?? undefined,
        source: "plugin",
        pluginId: pl.id,
      });
    }
  }
  return out;
});

/* 插件主题 id 串（逗号分隔）：App 依赖它重放 applyTheme——
   重启后持久化的插件主题 id 在插件列表加载完成前无法解析（findTheme 找不到），
   主题引擎此时只应用默认外观不覆盖持久化值；列表就绪后本 key 变化触发重放。 */
const pluginThemeKey = computed(() => pluginThemes.value.map((t) => t.id).join(","));

watch(pluginThemes, (themes) => {
  setPluginThemes(themes);
});

/* 工作区切换 / 首次进入时刷新插件列表 */
watch(
  () => vaultState.path,
  () => void refresh(),
  { immediate: true },
);

/** 组件入口：状态 + 操作函数（用法同 useVault） */
export function usePlugins() {
  return {
    state,
    navItems,
    pluginThemeKey,
    refresh,
    setEnabled,
    reload,
    uninstall,
    invoke,
    commandsOf,
  };
}
