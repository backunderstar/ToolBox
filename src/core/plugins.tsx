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
import { useVault } from "./vault";

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
  const isMock = useMemo(
    () => new URLSearchParams(window.location.search).has("mock"),
    []
  );
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
      return {
        app: {
          registerCommand: (cmd) => {
            if (!cmd?.id || typeof cmd.run !== "function") {
              console.error(`[plugin:${pluginId}] registerCommand 参数非法`);
              return;
            }
            rt.commands.set(cmd.id, cmd);
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
        log: (...args) =>
          console.log(`[plugin:${pluginId}]`, ...args),
      };
    },
    [getRuntime]
  );

  /** 加载并求值一个 webview 插件入口（注册其命令） */
  const loadWebviewPlugin = useCallback(
    async (plugin: PluginInfo) => {
      if (plugin.runtime !== "webview" || !plugin.entry) return;
      const rt = getRuntime(plugin.id);
      // 重载时清空命令与事件监听，避免旧回调残留/重复注册
      rt.commands.clear();
      rt.listeners.clear();
      try {
        // 插件装在全局目录（%APPDATA%/com.toolbox.desktop/plugins/），
        // 由 Rust 侧限定在插件目录内读取入口文件
        const code = await pluginsReadFile(plugin.id, plugin.entry);
        // 用 Blob URL <script> 注入执行，而非 new Function：
        // 打包版 CSP（script-src 'self' blob:）会拦截 eval / Function 构造器。
        // 保持原 api 参数契约：包一层 IIFE 传入全局句柄，运行期异常回写全局标记。
        //
        // api 句柄用**按插件独立**的全局键（Promise.all 并发加载时不会串台：
        // 共享同一个键会被后加载者覆盖 / 被先完成者 delete，导致注册错插件或崩溃）。
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
        const url = URL.createObjectURL(
          new Blob([wrapped], { type: "text/javascript" })
        );
        try {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement("script");
            script.src = url;
            script.onload = () => {
              const err = w.__TB_PLUGIN_ERROR__;
              delete w.__TB_PLUGIN_ERROR__;
              if (typeof err === "string") reject(new Error(err));
              else resolve();
            };
            script.onerror = () =>
              reject(new Error("插件脚本加载失败（可能被 CSP 拦截）"));
            document.head.appendChild(script);
          });
        } finally {
          // 无论成功/失败（含 onerror reject）都清理句柄与 Blob URL，防泄漏
          delete w[apiKey];
          delete w.__TB_PLUGIN_ERROR__;
          URL.revokeObjectURL(url);
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
    [buildApi, getRuntime]
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
        },
        {
          id: "core-records",
          name: "记录",
          version: "0.1.0",
          description: "核心插件：工作记录（data/records CRUD + 搜索提供者）",
          runtime: "native",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: ["records.list", "records.create", "records.save", "records.delete"],
          builtin: true,
          provider: true,
          system: false,
          ui: null,
          nav: [{ id: "records", label: "记录", icon: "notebook", group: "工作区", view: "RecordsView" }],
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
          nav: [{ id: "notes", label: "笔记", icon: "file-text", group: "工作区", view: "NotesView" }],
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
          nav: [{ id: "checklist", label: "清单", icon: "check", group: "工作区", view: "ChecklistView" }],
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
          nav: [{ id: "projects", label: "项目", icon: "folder", group: "工作区", view: "ProjectsView" }],
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
          nav: [{ id: "blog", label: "博客发布", icon: "globe", group: "系统", view: "BlogView" }],
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
          nav: [{ id: "ai", label: "AI 整理", icon: "sparkle", group: "系统", view: "AIChatView" }],
        },
        {
          id: "core-search",
          name: "搜索",
          version: "0.1.0",
          description: "系统插件：全文搜索（SQLite FTS5 索引，不可禁用）",
          runtime: "native",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: [],
          builtin: true,
          provider: false,
          system: true,
          ui: null,
          nav: [],
        },
        {
          id: "core-backup",
          name: "备份",
          version: "0.1.0",
          description: "系统插件：自动备份（快照 + 配置/插件存档 + 恢复，不可禁用）",
          runtime: "native",
          entry: null,
          enabled: true,
          status: "ready",
          error: null,
          commands: [],
          builtin: true,
          provider: false,
          system: true,
          ui: null,
          nav: [],
        },
      ];
      setPlugins(mock);
      const rt = getRuntime("text-stats");
      rt.commands.clear();
      rt.commands.set("analyze", {
        id: "analyze",
        name: "统计文本",
        run: async (args) => {
          const text = typeof (args as { text?: unknown })?.text === "string"
            ? ((args as { text: string }).text)
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
          const out = data.map((r) =>
            Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))
          );
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
          .map((pl) => loadWebviewPlugin(pl))
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
    [isMock, refresh]
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
    [isMock, refresh]
  );

  const uninstall = useCallback(
    async (id: string) => {
      const p = vaultRef.current;
      if (!p) return;
      await pluginsUninstall(p, id); // 停进程 + 清状态 + 删目录（回收站）
      await refresh();
    },
    [refresh]
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
    [plugins, getRuntime, isMock]
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
    [plugins, getRuntime]
  );

  /* 启用插件的导航入口（内置插件声明 nav 时并入侧边栏） */
  const navItems = useMemo(() => {
    const out: PluginNav[] = [];
    for (const pl of plugins) {
      if (pl.enabled && pl.builtin) {
        for (const n of pl.nav) out.push(n);
      }
    }
    return out;
  }, [plugins]);

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
    }),
    [plugins, loading, runtimeErrors, refresh, setEnabled, reload, uninstall, invoke, commandsOf, navItems]
  );

  return <PluginContext.Provider value={value}>{children}</PluginContext.Provider>;
}
