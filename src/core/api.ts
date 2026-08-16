import { invoke } from "@tauri-apps/api/core";

/* ---- 类型（与 Rust 侧 serde camelCase 对应） ---- */

export interface PingInfo {
  message: string;
  coreVersion: string;
  os: string;
}

export interface VaultSettings {
  path: string | null;
}

export interface FileEntry {
  name: string;
  path: string; // vault 相对路径，/ 分隔
  isDir: boolean;
  /** 文件字节数（目录为 null） */
  size: number | null;
}

export interface SearchHit {
  path: string;
  filename: string;
  snippet: string;
  /** 搜索来源：缺省为文件全文；插件提供者为插件 id */
  source?: string;
}

/** 插件声明的导航入口（Rust NavDecl 对应；pluginId 由前端收集时补充，App 动态路由用） */
export interface PluginNav {
  id: string;
  label: string;
  icon: string;
  group: string;
  /** 所属插件 id：点击导航项时据此渲染该插件的自带前端 */
  pluginId: string;
}

/** 插件信息（与 Rust PluginInfo 对应，serde camelCase） */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime: "webview" | "process" | "native";
  /** webview 插件入口文件（相对插件目录） */
  entry: string | null;
  enabled: boolean;
  status: "error" | "ready" | "stopped";
  error: string | null;
  commands: string[];
  /** 核心插件（native，随应用分发，不可卸载） */
  builtin: boolean;
  /** 搜索提供者（实现 search.provide 命令，启用后进入全局搜索） */
  provider: boolean;
  /** 系统插件（数据安全/横切能力，不可禁用） */
  system: boolean;
  /** 插件自带前端入口（相对插件目录；缺省用宿主内置视图组件） */
  ui: string | null;
  /** 插件声明的导航入口（启用时并入侧边栏） */
  nav: PluginNav[];
}

/* ---- IPC 封装 ---- */

export const ping = () => invoke<PingInfo>("ping");

export const vaultGet = () => invoke<VaultSettings>("vault_get");
export const vaultSet = (path: string) => invoke<void>("vault_set", { path });

/* ---- 笔记文件操作（经 core-notes 原生插件，宿主进程内 FFI） ---- */

export const fsList = (vault: string) =>
  pluginCall(vault, "core-notes", "notes.list", {}) as Promise<FileEntry[]>;
export const fsRead = (vault: string, rel: string) =>
  pluginCall(vault, "core-notes", "notes.read", { rel }) as Promise<string>;
export const fsWrite = (vault: string, rel: string, content: string) =>
  pluginCall(vault, "core-notes", "notes.write", { rel, content }) as Promise<void>;
export const fsCreate = (vault: string, rel: string) =>
  pluginCall(vault, "core-notes", "notes.create", { rel }) as Promise<void>;
export const fsDelete = (vault: string, rel: string) =>
  pluginCall(vault, "core-notes", "notes.delete", { rel }) as Promise<void>;
export const fsRename = (vault: string, from: string, to: string) =>
  pluginCall(vault, "core-notes", "notes.rename", { from, to }) as Promise<void>;

/** 聚合搜索：文件全文 + 启用的搜索提供者插件命中（source 字段标记来源） */
export const searchAll = (vault: string, query: string) =>
  invoke<SearchHit[]>("search_all", { vault, query });

/* ---- 插件系统 ---- */

export const pluginsList = (vault: string) => invoke<PluginInfo[]>("plugins_list", { vault });
export const pluginsSetEnabled = (vault: string, id: string, enabled: boolean) =>
  invoke<void>("plugins_set_enabled", { vault, id, enabled });
export const pluginsReload = (vault: string, id: string) =>
  invoke<void>("plugins_reload", { vault, id });
export const pluginsUninstall = (vault: string, id: string) =>
  invoke<void>("plugins_uninstall", { vault, id });
/** 重新安装已卸载的核心插件（从随应用分发的资源恢复 DLL + 目录） */
export const pluginsReinstallCore = (vault: string, id: string) =>
  invoke<void>("plugins_reinstall_core", { vault, id });
/** 已卸载的核心插件 id 列表（前端展示"重新安装"入口） */
export const pluginsRemovedCore = () => invoke<string[]>("plugins_removed_core");
/** 界面安装 DLL 插件：source = 用户选择的 .zip 包路径或插件目录路径；kind = "zip" | "dir" */
export const pluginsInstallNative = (vault: string, source: string, kind: string) =>
  invoke<string>("plugins_install_native", { vault, source, kind });
/** 读取全局插件目录内的文件（webview 插件入口加载用，插件已不在 vault 内） */
export const pluginsReadFile = (id: string, rel: string) =>
  invoke<string>("plugins_read_file", { id, rel });
export const pluginsInvoke = (vault: string, id: string, command: string, args: unknown) =>
  invoke<unknown>("plugins_invoke", { vault, id, command, args });
/** 统一插件命令调用（native → FFI；process → JSON-RPC；webview 由前端调用） */
export const pluginCall = (vault: string, id: string, command: string, args: unknown) =>
  invoke<unknown>("plugin_call", { vault, id, command, args });

/* ---- 系统 ---- */

/** 在系统文件管理器中打开路径（Windows：资源管理器） */
export const openInExplorer = (path: string) => invoke<void>("open_in_explorer", { path });

/* ---- M6 AI 配置（经 core-ai 原生插件；无显式 vault 用当前工作区） ---- */

export interface AiConfig {
  baseUrl: string;
  model: string;
  /** 是否已配置 API Key（Key 存系统凭据管理器，不返回明文） */
  hasKey: boolean;
}

export const aiConfigGet = () =>
  currentVault().then((v) => pluginCall(v, "core-ai", "ai.configGet", {})) as Promise<AiConfig>;
export const aiConfigSet = (config: { baseUrl: string; model: string }) =>
  currentVault().then((v) => pluginCall(v, "core-ai", "ai.configSet", { config })) as Promise<void>;
/** 保存 API Key 到系统凭据管理器（Windows 凭据管理器 / Keychain） */
export const aiConfigSetKey = (key: string) =>
  currentVault().then((v) => pluginCall(v, "core-ai", "ai.configSetKey", { key })) as Promise<void>;
export const aiConfigClearKey = () =>
  currentVault().then((v) => pluginCall(v, "core-ai", "ai.configClearKey", {})) as Promise<void>;
export const aiTest = () =>
  currentVault().then((v) => pluginCall(v, "core-ai", "ai.test", {})) as Promise<string>;

/* ---- 自动备份（宿主内嵌命令，原 core-backup 插件命令；搜索/备份已迁回本体框架） ---- */

export interface BackupConfig {
  enabled: boolean;
  intervalMinutes: number;
  keep: number;
  /** 上次成功备份时间（unix 秒） */
  lastBackupAt: number | null;
}

export interface BackupInfo {
  path: string;
  sizeBytes: number;
  fileCount: number;
}

export interface BackupEntry {
  name: string;
  /** unix 秒 */
  timestamp: number;
  sizeBytes: number;
  /** 备份含配置存档（%APPDATA% json） */
  hasConfig: boolean;
  /** 备份含插件存档（全局插件目录） */
  hasPlugins: boolean;
}

export const backupConfigGet = () => invoke<BackupConfig>("backup_config_get");
export const backupConfigSet = (config: BackupConfig) =>
  invoke<void>("backup_config_set", { config });
export const backupNow = (vault: string) => invoke<BackupInfo>("backup_now", { vault });
export const backupList = (vault: string) => invoke<BackupEntry[]>("backup_list", { vault });
/** 恢复到备份点（恢复前自动保存当前状态；覆盖合并，保留新增文件） */
export const backupRestore = (vault: string, name: string) =>
  invoke<BackupInfo>("backup_restore", { vault, name });

/* ---- 浮窗快速待办（经 core-todos 原生插件；当前工作区来自 vault 配置） ---- */

/** 读取当前工作区路径（todos/plugin_call 等无显式 vault 的命令用） */
async function currentVault(): Promise<string> {
  const s = await vaultGet();
  if (!s.path) throw new Error("请先选择工作区");
  return s.path;
}

/** 显示 / 隐藏浮窗（返回操作后可见状态） */
export const floatToggle = () => invoke<boolean>("float_toggle");
/** 锁定 / 解锁浮窗位置（锁定时禁用拖拽与改大小） */
export const floatSetLocked = (locked: boolean) => invoke<void>("float_set_locked", { locked });
