/**
 * 统一插件前端运行时：webview 插件（命令注册）与核心插件自带前端（ui 挂载）
 * 共用同一套"读入口 → Blob script 注入 → api 桥"机制。
 *
 * 加载链路：
 *   plugins_read_file 读入口 JS → Blob URL <script> 注入（CSP script-src blob: 允许）
 *   → 插件顶层代码执行（注册命令 / 注册 __TB_PLUGIN_UI__[id]）
 *   → 宿主注入统一 api 桥（call → plugin_call；on → plugin-event 过滤；context）
 */
import { listen } from "@tauri-apps/api/event";
import { pluginCall, pluginLog } from "./api";

/** 日志级别（插件日志统一通道：debug/info/warn/error，落盘 + dev 终端） */
export type PluginLogLevel = "debug" | "info" | "warn" | "error";

/** 宿主导航桥（主窗口插件界面用：跨视图跳转） */
export interface PluginNavBridge {
  go: (view: string) => void;
}

/** 宿主能力（主窗口插件 UI 可用；搜索迁回宿主本体后的统一入口） */
export interface PluginHostApi {
  /** 全文搜索（经宿主 search_all，含搜索提供者聚合；vault 取桥内当前工作区） */
  search: (query: string) => Promise<import("./api").SearchHit[]>;
}

/** 注入给插件的统一 api 桥（webview 插件与插件自带前端同构） */
export interface PluginBridgeApi {
  pluginId: string;
  /**
   * 调用插件命令：默认调本插件（native → FFI / process → JSON-RPC）；
   * 可指定 targetPluginId 跨插件调用（如博客界面改笔记 frontmatter）。
   */
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  /** 订阅 plugin-event（默认本插件；可指定 targetPluginId 订阅其他插件的事件），返回取消函数 */
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  /** 写宿主运行日志（落盘 logs/ + dev 终端，来源 [plugin:<id>]；level 缺省 info）。
   *  process 插件也可用核心 API `log`（Python call_core("log", {message, level})）。 */
  log: (level: PluginLogLevel, message: string) => void;
  /** 宿主注入的上下文：vault 路径 + 扩展字段（如 activePath / activeContent） */
  context: { vault: string | null } & Record<string, unknown>;
  /** 宿主导航（主窗口可用；浮窗等独立窗口为 undefined） */
  nav?: PluginNavBridge;
  /** 宿主能力（主窗口可用；搜索/系统级能力迁回本体后经此调用） */
  host?: PluginHostApi;
}

/** buildBridgeApi 选项：nav（主窗口导航）+ context 扩展字段（host 状态快照）+ host 能力 */
export interface BuildBridgeOptions {
  nav?: PluginNavBridge;
  context?: Record<string, unknown>;
  host?: PluginHostApi;
}

/** webview 插件本地命令注册表（pluginId → commandId → run）。
 *
 * **为什么需要**：Rust 的 `plugin_call` 只路由 native/process 插件（webview
 * 插件在 Rust 侧没有命令分发——"webview 插件请由前端调用"）。但 webview 插件
 * 的**自带前端 UI**（PluginUiView 挂载，api 由 buildBridgeApi 构造）与命令注册式
 * 入口（main.js）共享同一窗口：`api.call("analyze")` 若直接走 plugin_call 会被
 * Rust 拒绝。这里维护一份"本地注册表"：webview 插件经 `api.app.registerCommand`
 * 注册的命令写入此表，`buildBridgeApi.call` 同插件调用时**先查本地表**，命中即
 * 本地执行；未命中才走统一桥（跨调 native/process 插件）。UI 与命令注册式由此打通。
 */
const localCommands = new Map<string, Map<string, (args: unknown) => unknown | Promise<unknown>>>();

/** 注册 webview 插件命令（plugins.tsx 的 registerCommand 调用） */
export function registerLocalCommand(
  pluginId: string,
  id: string,
  run: (args: unknown) => unknown | Promise<unknown>,
): void {
  let m = localCommands.get(pluginId);
  if (!m) {
    m = new Map();
    localCommands.set(pluginId, m);
  }
  m.set(id, run);
}

/** 清空某插件的本地命令（插件重载/卸载时调用，防旧回调残留） */
export function clearLocalCommands(pluginId: string): void {
  localCommands.delete(pluginId);
}

/** 清理不再启用的 webview 插件的本地命令（refresh 后调用）。
 *  被禁用/卸载的插件不会走 loadWebviewPlugin，若不清这里，api.call 仍会命中
 *  过期注册执行旧插件代码（内存泄漏 + 行为错乱）。 */
export function pruneLocalCommands(keepIds: ReadonlySet<string>): void {
  for (const id of localCommands.keys()) {
    if (!keepIds.has(id)) localCommands.delete(id);
  }
}

/** 是否运行在 Tauri 环境（浏览器 mock 下无 __TAURI_INTERNALS__，插件日志回退 console） */
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 构造统一 api 桥（vault 由调用方提供 getter） */
export function buildBridgeApi(
  pluginId: string,
  getVault: () => string | null,
  opts?: BuildBridgeOptions,
): PluginBridgeApi {
  const vault = () => getVault();
  return {
    pluginId,
    log: (level, message) => {
      if (isTauriRuntime()) {
        pluginLog(pluginId, level, message).catch(() => undefined);
      } else {
        console.log(`[plugin:${pluginId}] ${level}:`, message);
      }
    },
    call: (command, args, targetPluginId) => {
      // webview 插件本地命令优先（同插件调用；targetPluginId 指定其他插件时走桥）
      if (!targetPluginId || targetPluginId === pluginId) {
        const run = localCommands.get(pluginId)?.get(command);
        if (run) {
          try {
            return Promise.resolve(run(args ?? {}));
          } catch (e) {
            return Promise.reject(e instanceof Error ? e : new Error(String(e)));
          }
        }
      }
      const v = vault();
      if (!v) return Promise.reject(new Error("工作区未设置"));
      // args 缺省 {}（undefined 会被 invoke 序列化丢弃导致 Rust 侧缺参）
      return pluginCall(v, targetPluginId ?? pluginId, command, args ?? {});
    },
    on: (event, cb, targetPluginId) => {
      let un: (() => void) | null = null;
      // 取消竞态防护：listen() 是异步 promise，取消函数可能在它 resolve 之前
      // 就被调用（插件 UI 快速卸载/重挂载）。若直接返回 un?.()，此时 un 仍为
      // null，取消是 no-op → 监听器永久泄漏。用 cancelled 标志记住"已取消"，
      // promise resolve 后立即注销（fn() 即取消函数，这里直接调用）。
      let cancelled = false;
      const pid = targetPluginId ?? pluginId;
      void listen<{ pluginId: string; event: string; data: unknown }>("plugin-event", (e) => {
        if (cancelled) return;
        if (e.payload.pluginId === pid && e.payload.event === event) {
          cb(e.payload.data);
        }
      })
        .then((fn) => {
          if (cancelled) fn();
          else un = fn;
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
        un?.();
      };
    },
    context: { vault: vault(), ...opts?.context },
    ...(opts?.nav ? { nav: opts.nav } : {}),
    ...(opts?.host ? { host: opts.host } : {}),
  };
}

/**
 * 注入插件脚本：Blob URL <script>（CSP script-src blob: 允许），onload 后 resolve。
 * 返回清理函数（移除 <script> 节点）。
 */
export async function injectPluginScript(code: string): Promise<() => void> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const script = document.createElement("script");
  try {
    await new Promise<void>((resolve, reject) => {
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("插件脚本加载失败（可能被 CSP 拦截）"));
      document.head.appendChild(script);
    });
    return () => script.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
