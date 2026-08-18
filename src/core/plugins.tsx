import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
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
  type PluginBridgeApi,
} from "./pluginRuntime";
import { useVault } from "./vault";
import { setPluginThemes, type ThemeDef } from "../themes/themes";

/**
 * 插件系统（M2）
 *
 * - 清单发现与启用状态由 Rust 核心管理（plugins_list / set_enabled / reload）
 * - webview 插件：前端读取入口 JS，经 `new Function("api", code)` 执行，
 *   插件通过 api.app.registerCommand 把命令注册进本地注册表
 * - process 插件：命令经 plugins_invoke 走 JSON-RPC 桥（Python 子进程）
 *
 * webview 沙箱为 v1 尽力而为：提供受限 api 对象（app/fs/events/log），
 * 不隔离 window 访问；后续里程碑再引入真正沙箱（Worker/ShadowRealm）。
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

interface PluginContextValue {
  plugins: PluginInfo[];
  loading: boolean;
  /** 插件加载/运行错误（含 webview 入口求值失败） */
  runtimeErrors: Record<string, string>;
  refresh: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  reload: (id: string) => Promise<void>;
  /** 卸载插件：停进程 + 清启用状态 + 删除插件目录（回收站） */
  uninstall: (id: string) => Promise<void>;
  /** 调用插件命令：webview 直跑注册表，process/native 走 IPC 桥 */
  invoke: (pluginId: string, command: string, args: unknown) => Promise<unknown>;
  /** 某插件的命令元数据（webview 来自注册表，process 来自清单） */
  commandsOf: (pluginId: string) => { id: string; name: string }[];
  /** 启用插件的导航入口（核心插件 nav 声明并入侧边栏） */
  navItems: PluginNav[];
  /** 皮肤插件主题 id 串（逗号分隔，顺序稳定）：主题引擎注册表投影后的摘要，
   *  AppInner 依赖它——插件刷新完成后重放 applyTheme（重启后持久化的插件
   *  主题 id 要等插件列表加载才可解析；插件禁用/卸载时据此回落默认主题）。 */
  pluginThemeKey: string;
}

const PluginContext = createContext<PluginContextValue | null>(null);

export function usePlugins(): PluginContextValue {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePlugins 必须在 PluginProvider 内使用");
  return ctx;
}

/** 单个插件的命令注册表 + 事件中心 */
interface PluginRuntime {
  commands: Map<string, PluginCommand>;
  listeners: Map<string, Set<(data: unknown) => void>>;
}

export function PluginProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  const isMock = useMemo(() => new URLSearchParams(window.location.search).has("mock"), []);
  const vaultRef = useRef(vault.path);
  vaultRef.current = vault.path;

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, string>>({});

  const runtimes = useRef(new Map<string, PluginRuntime>());

  const getRuntime = useCallback((pluginId: string): PluginRuntime => {
    let rt = runtimes.current.get(pluginId);
    if (!rt) {
      rt = { commands: new Map(), listeners: new Map() };
      runtimes.current.set(pluginId, rt);
    }
    return rt;
  }, []);

  /** 构造传给 webview 插件入口的 api 对象 */
  const buildApi = useCallback(
    (pluginId: string): PluginApi => {
      const rt = getRuntime(pluginId);
      const vaultPath = () => vaultRef.current;
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
            // （plugin_call 只路由 native/process，webview 命令靠这里本地执行）
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
        log: (...args) => console.log(`[plugin:${pluginId}]`, ...args),
        call: bridge.call,
        on: bridge.on,
        context: bridge.context,
      };
    },
    [getRuntime],
  );

  /** 加载并求值一个 webview 插件入口（注册其命令） */
  const loadWebviewPlugin = useCallback(
    async (plugin: PluginInfo) => {
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
        // api 句柄用**按插件独立**的全局键（Promise.all 并发加载时不会串台）。
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
        setRuntimeErrors((prev) => {
          const next = { ...prev };
          delete next[plugin.id];
          return next;
        });
      } catch (e) {
        setRuntimeErrors((prev) => ({
          ...prev,
          [plugin.id]: String(e),
        }));
        console.error(`[plugin:${plugin.id}] 入口加载失败`, e);
      }
    },
    [buildApi, getRuntime],
  );

  /** 重新发现插件 + 加载所有已启用 webview 插件的命令 */
  const refresh = useCallback(async () => {
    if (isMock) {
      // 浏览器演示模式：内置两个示例插件（不经过 Rust / 文件系统）
      const mock: PluginInfo[] = [
        {
          id: "text-stats",
          name: "文本统计",
          version: "0.1.0",
          description: "统计文本的字数、词数、行数与段落数（webview JS 插件示例）",
          runtime: "webview",
          entry: "main.js",
          enabled: true,
          status: "ready",
          error: null,
          commands: ["analyze"],
          builtin: false,
          provider: false,
          system: false,
          ui: null,
          nav: [],
          theme: null,
        },
        {
          id: "csv-tool",
          name: "CSV 工具",
          version: "0.1.0",
          description: "CSV ⇄ JSON / TSV 转换（process Python 插件示例）",
          runtime: "process",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: ["csv.convert"],
          builtin: false,
          provider: false,
          system: false,
          ui: null,
          nav: [],
          theme: null,
        },
        {
          id: "core-notes",
          name: "笔记",
          version: "0.1.0",
          description: "核心插件：笔记文件操作（notes/ 列表/读写/新建/删除/重命名）",
          runtime: "native",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: [],
          builtin: true,
          provider: false,
          system: false,
          ui: null,
          nav: [
            {
              id: "notes",
              label: "笔记",
              icon: "file-text",
              group: "工作区",
              pluginId: "core-notes",
            },
          ],
          theme: null,
        },
        {
          id: "core-checklists",
          name: "清单",
          version: "0.1.0",
          description: "核心插件：清单（data/checklists CRUD）",
          runtime: "native",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: [],
          builtin: true,
          provider: false,
          system: false,
          ui: null,
          nav: [
            {
              id: "checklist",
              label: "清单",
              icon: "check",
              group: "工作区",
              pluginId: "core-checklists",
            },
          ],
          theme: null,
        },
        {
          id: "core-projects",
          name: "项目",
          version: "0.1.0",
          description: "核心插件：项目文件管理（projects/ 目录/归档/默认应用打开）",
          runtime: "native",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: [],
          builtin: true,
          provider: false,
          system: false,
          ui: null,
          nav: [
            {
              id: "projects",
              label: "项目",
              icon: "folder",
              group: "工作区",
              pluginId: "core-projects",
            },
          ],
          theme: null,
        },
        {
          id: "core-blog",
          name: "博客",
          version: "0.1.0",
          description: "核心插件：博客发布（frontmatter/站点生成/内置预览服务器）",
          runtime: "native",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: [],
          builtin: true,
          provider: false,
          system: false,
          ui: null,
          nav: [
            { id: "blog", label: "博客发布", icon: "globe", group: "系统", pluginId: "core-blog" },
          ],
          theme: null,
        },
        {
          id: "core-ai",
          name: "AI",
          version: "0.1.0",
          description: "核心插件：AI 整理（OpenAI 兼容对话 + SSE 流式）",
          runtime: "native",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: [],
          builtin: true,
          provider: false,
          system: false,
          ui: null,
          nav: [
            { id: "ai", label: "AI 整理", icon: "sparkle", group: "系统", pluginId: "core-ai" },
          ],
          theme: null,
        },
        {
          id: "theme-maple",
          name: "枫叶红",
          version: "0.1.0",
          description: "皮肤插件示例：陶土枫叶红，演示令牌 + CSS 双通道换肤",
          runtime: "webview",
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
          theme: {
            base: "light",
            tokens: { "--accent": "#a8402c", "--accent-strong": "#7d2d1e" },
            css: null,
          },
        },
      ];
      setPlugins(mock);
      const rt = getRuntime("text-stats");
      rt.commands.clear();
      rt.commands.set("analyze", {
        id: "analyze",
        name: "统计文本",
        run: async (args) => {
          const text =
            typeof (args as { text?: unknown })?.text === "string"
              ? (args as { text: string }).text
              : "";
          const trimmed = text.trim();
          return {
            chars: [...text].length,
            words: trimmed ? trimmed.split(/\s+/).length : 0,
            lines: text.length === 0 ? 0 : text.split("\n").length,
            paragraphs: trimmed ? trimmed.split(/\n\s*\n/).length : 0,
            empty: text.length === 0,
          };
        },
      });
      const rt2 = getRuntime("csv-tool");
      rt2.commands.clear();
      rt2.commands.set("csv.convert", {
        id: "csv.convert",
        name: "CSV 转换",
        run: async (args) => {
          const { csv = "", format = "json" } = (args ?? {}) as { csv?: string; format?: string };
          const rows = csv
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0)
            .map((l) => l.split(",").map((c) => c.trim()));
          if (format === "tsv") {
            return { text: rows.map((r) => r.join("\t")).join("\n") };
          }
          if (rows.length === 0) return { text: "[]" };
          const [header, ...data] = rows;
          const out = data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
          return { text: JSON.stringify(out, null, 2) };
        },
      });
      setRuntimeErrors({});
      return;
    }
    const p = vaultRef.current;
    if (!p) {
      setPlugins([]);
      return;
    }
    setLoading(true);
    try {
      const list = await pluginsList(p);
      setPlugins(list);
      // 重置所有注册表（保留运行时对象，只清命令）
      for (const rt of runtimes.current.values()) rt.commands.clear();
      setRuntimeErrors({});
      await Promise.all(
        list
          .filter((pl) => pl.enabled && pl.runtime === "webview")
          .map((pl) => loadWebviewPlugin(pl)),
      );
    } catch (e) {
      console.error("[plugins] 刷新失败", e);
    } finally {
      setLoading(false);
    }
  }, [isMock, getRuntime, loadWebviewPlugin]);

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const p = vaultRef.current;
      if (!p) return;
      if (!isMock) {
        await pluginsSetEnabled(p, id, enabled);
      }
      await refresh();
    },
    [isMock, refresh],
  );

  const reload = useCallback(
    async (id: string) => {
      const p = vaultRef.current;
      if (!p) return;
      if (!isMock) {
        await pluginsReload(p, id);
      }
      await refresh();
    },
    [isMock, refresh],
  );

  const uninstall = useCallback(
    async (id: string) => {
      const p = vaultRef.current;
      if (!p) return;
      await pluginsUninstall(p, id); // 停进程 + 清状态 + 删目录（回收站）
      await refresh();
    },
    [refresh],
  );

  const invoke = useCallback(
    async (pluginId: string, command: string, args: unknown) => {
      const plugin = plugins.find((pl) => pl.id === pluginId);
      if (!plugin) throw new Error(`插件不存在: ${pluginId}`);
      // mock 模式下所有插件（含 process/native）都走注册表内联实现；
      // 真实模式下 webview 走注册表、process/native 走 IPC 桥
      if (isMock || plugin.runtime === "webview") {
        const cmd = getRuntime(pluginId).commands.get(command);
        if (!cmd) throw new Error(`命令未注册: ${command}`);
        return cmd.run(args);
      }
      const p = vaultRef.current;
      if (!p) throw new Error("工作区未设置");
      return plugin.runtime === "native"
        ? pluginCall(p, pluginId, command, args)
        : pluginsInvoke(p, pluginId, command, args);
    },
    [plugins, getRuntime, isMock],
  );

  const commandsOf = useCallback(
    (pluginId: string) => {
      const plugin = plugins.find((pl) => pl.id === pluginId);
      if (!plugin) return [];
      if (plugin.runtime === "webview") {
        return [...getRuntime(pluginId).commands.values()].map((c) => ({
          id: c.id,
          name: c.name,
        }));
      }
      return plugin.commands.map((c) => ({ id: c, name: c }));
    },
    [plugins, getRuntime],
  );

  /* 启用插件的导航入口（任何启用的插件都可声明 nav 并入侧边栏；
     核心插件与外部插件一视同仁）。pluginId 由这里补充——App 路由按
     nav.id 匹配后据此渲染对应插件的自带前端（PluginUiView）。 */
  const navItems = useMemo(() => {
    const out: PluginNav[] = [];
    for (const pl of plugins) {
      if (pl.enabled) {
        for (const n of pl.nav) out.push({ ...n, pluginId: pl.id });
      }
    }
    return out;
  }, [plugins]);

  /* 皮肤插件 → 主题定义投影：启用且声明 theme 的插件并入主题引擎注册表
     （setPluginThemes），设置页主题选择器即可看到；应用时走"令牌 + CSS 双通道"
     （themes.ts applyTheme）。纯数据投影：不注入脚本、不启动任何运行时。 */
  const pluginThemes = useMemo<ThemeDef[]>(() => {
    const out: ThemeDef[] = [];
    for (const pl of plugins) {
      if (pl.enabled && pl.theme) {
        out.push({
          id: pl.id, // 主题 id = 插件 id（插件 id 全局唯一，天然不冲突）
          name: pl.name,
          description: pl.description || "插件主题",
          base: pl.theme.base,
          tokens: pl.theme.tokens ?? {},
          css: pl.theme.css,
          source: "plugin",
          pluginId: pl.id,
        });
      }
    }
    return out;
  }, [plugins]);

  /* 插件主题 id 串（逗号分隔）：AppInner 依赖它重放 applyTheme——
     重启后持久化的插件主题 id 在插件列表加载完成前无法解析（findTheme 找不到），
     主题引擎此时只应用默认外观不覆盖持久化值；列表就绪后本 key 变化触发重放。 */
  const pluginThemeKey = useMemo(() => pluginThemes.map((t) => t.id).join(","), [pluginThemes]);

  useEffect(() => {
    setPluginThemes(pluginThemes);
  }, [pluginThemes]);

  /* 工作区切换 / 首次进入时刷新插件列表 */
  useEffect(() => {
    void refresh();
  }, [refresh, vault.path]);

  const value: PluginContextValue = useMemo(
    () => ({
      plugins,
      loading,
      runtimeErrors,
      refresh,
      setEnabled,
      reload,
      uninstall,
      invoke,
      commandsOf,
      navItems,
      pluginThemeKey,
    }),
    [
      plugins,
      loading,
      runtimeErrors,
      refresh,
      setEnabled,
      reload,
      uninstall,
      invoke,
      commandsOf,
      navItems,
      pluginThemeKey,
    ],
  );

  return <PluginContext.Provider value={value}>{children}</PluginContext.Provider>;
}
