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

/** 插件声明的导航入口（Rust NavDecl 对应） */
export interface PluginNav {
  id: string;
  label: string;
  icon: string;
  group: string;
  view: string;
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
  /** 插件声明的导航入口（启用时并入侧边栏） */
  nav: PluginNav[];
}

/* ---- IPC 封装 ---- */

export const ping = () => invoke<PingInfo>("ping");

export const vaultGet = () => invoke<VaultSettings>("vault_get");
export const vaultSet = (path: string) =>
  invoke<void>("vault_set", { path });

/* ---- 笔记文件操作（经 core-notes 原生插件，宿主进程内 FFI） ---- */

export const fsList = (vault: string) =>
  pluginCall(vault, "core-notes", "notes.list", {}) as Promise<FileEntry[]>;
/** 列出 vault 指定目录下的全部条目（含非 .md 文件，供 JSON 数据枚举） */
export const fsListDir = (vault: string, dir: string) =>
  pluginCall(vault, "core-notes", "notes.listDir", { dir }) as Promise<FileEntry[]>;
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

export const pluginsList = (vault: string) =>
  invoke<PluginInfo[]>("plugins_list", { vault });
export const pluginsSetEnabled = (vault: string, id: string, enabled: boolean) =>
  invoke<void>("plugins_set_enabled", { vault, id, enabled });
export const pluginsReload = (vault: string, id: string) =>
  invoke<void>("plugins_reload", { vault, id });
export const pluginsUninstall = (vault: string, id: string) =>
  invoke<void>("plugins_uninstall", { vault, id });
/** 读取全局插件目录内的文件（webview 插件入口加载用，插件已不在 vault 内） */
export const pluginsReadFile = (id: string, rel: string) =>
  invoke<string>("plugins_read_file", { id, rel });
export const pluginsInvoke = (
  vault: string,
  id: string,
  command: string,
  args: unknown
) => invoke<unknown>("plugins_invoke", { vault, id, command, args });
/** 统一插件命令调用（native → FFI；process → JSON-RPC；webview 由前端调用） */
export const pluginCall = (
  vault: string,
  id: string,
  command: string,
  args: unknown
) => invoke<unknown>("plugin_call", { vault, id, command, args });

/* ---- 系统 ---- */

/** 在系统文件管理器中打开路径（Windows：资源管理器） */
export const openInExplorer = (path: string) =>
  invoke<void>("open_in_explorer", { path });

/** 用系统默认应用打开 URL（Tauri 环境经 opener 插件；浏览器环境回退 window.open） */
export const openUrl = (url: string) => {
  const w = window as Window & { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) {
    return import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  }
  window.open(url, "_blank");
  return Promise.resolve();
};

/* ---- M6 AI ---- */

export interface AiConfig {
  baseUrl: string;
  model: string;
  /** 是否已配置 API Key（Key 存系统凭据管理器，不返回明文） */
  hasKey: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const aiConfigGet = () => invoke<AiConfig>("ai_config_get");
export const aiConfigSet = (config: { baseUrl: string; model: string }) =>
  invoke<void>("ai_config_set", { config });
/** 保存 API Key 到系统凭据管理器（Windows 凭据管理器 / Keychain） */
export const aiConfigSetKey = (key: string) =>
  invoke<void>("ai_config_set_key", { key });
export const aiConfigClearKey = () => invoke<void>("ai_config_clear_key");
export const aiChat = (messages: ChatMessage[]) =>
  invoke<string>("ai_chat", { messages });
/** 流式对话：增量经 `ai-chunk` 事件推送（见 AIChatView），本调用在流结束后 resolve */
export const aiChatStream = (messages: ChatMessage[]) =>
  invoke<void>("ai_chat_stream", { messages });
/** `ai-chunk` 事件载荷 */
export interface AiChunk {
  text: string;
}
export const aiTest = () => invoke<string>("ai_test");

/* ---- M7 博客 ---- */

export interface PostMeta {
  path: string;
  title: string;
  date: string;
  tags: string[];
  status: string;
  /** 笔记文件最后修改时间（unix 秒） */
  mtime: number | null;
}

export interface BlogListResult {
  posts: PostMeta[];
  /** 站点最后生成时间（未生成过为 null） */
  siteGeneratedAt: number | null;
  /** 站点生成后又被修改过的已发布笔记数 */
  staleCount: number;
}

export interface BlogGenerateResult {
  siteDir: string;
  posts: number;
  indexUrl: string;
}

export const blogList = (vault: string) =>
  invoke<BlogListResult>("blog_list", { vault });
export const blogGenerate = (vault: string, siteTitle: string) =>
  invoke<BlogGenerateResult>("blog_generate", { vault, siteTitle });
export const blogPreviewStart = (vault: string) =>
  invoke<string>("blog_preview_start", { vault });
export const blogPreviewStop = () => invoke<void>("blog_preview_stop");
export const blogOpenFolder = (vault: string) =>
  invoke<void>("blog_open_folder", { vault });

/* ---- M8 项目文件管理 ---- */

export interface ProjectInfo {
  name: string;
  archived: boolean;
  fileCount: number;
}

export interface ProjectFile {
  name: string;
  /** 相对项目根，/ 分隔 */
  path: string;
  isDir: boolean;
  size: number | null;
}

export const projectsList = (vault: string) =>
  invoke<ProjectInfo[]>("projects_list", { vault });
export const projectsCreate = (vault: string, name: string) =>
  invoke<void>("projects_create", { vault, name });
export const projectsArchive = (vault: string, name: string) =>
  invoke<void>("projects_archive", { vault, name });
export const projectsUnarchive = (vault: string, name: string) =>
  invoke<void>("projects_unarchive", { vault, name });
export const projectsDelete = (vault: string, name: string, permanent = false) =>
  invoke<void>("projects_delete", { vault, name, permanent });
export const projectsFiles = (vault: string, name: string, dir: string) =>
  invoke<ProjectFile[]>("projects_files", { vault, name, dir });
export const projectsOpen = (vault: string, name: string, rel: string) =>
  invoke<void>("projects_open", { vault, name, rel });

/* ---- 自动备份 ---- */

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
export const backupNow = (vault: string) => invoke<BackupInfo>("backup_now_cmd", { vault });
export const backupList = (vault: string) => invoke<BackupEntry[]>("backup_list", { vault });
/** 恢复到备份点（恢复前自动保存当前状态；覆盖合并，保留新增文件） */
export const backupRestore = (vault: string, name: string) =>
  invoke<BackupInfo>("backup_restore", { vault, name });

/* ---- 浮窗快速待办（经 core-todos 原生插件；当前工作区来自 vault 配置） ---- */

export interface TodosItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

/** 读取当前工作区路径（todos/plugin_call 等无显式 vault 的命令用） */
async function currentVault(): Promise<string> {
  const s = await vaultGet();
  if (!s.path) throw new Error("请先选择工作区");
  return s.path;
}

export const todosList = () =>
  currentVault().then((v) =>
    pluginCall(v, "core-todos", "todos.list", {})
  ) as Promise<TodosItem[]>;
export const todosAdd = (text: string) =>
  currentVault().then((v) =>
    pluginCall(v, "core-todos", "todos.add", { text })
  ) as Promise<TodosItem[]>;
export const todosToggle = (id: string) =>
  currentVault().then((v) =>
    pluginCall(v, "core-todos", "todos.toggle", { id })
  ) as Promise<TodosItem[]>;
export const todosDelete = (id: string) =>
  currentVault().then((v) =>
    pluginCall(v, "core-todos", "todos.delete", { id })
  ) as Promise<TodosItem[]>;
export const todosClearDone = () =>
  currentVault().then((v) =>
    pluginCall(v, "core-todos", "todos.clearDone", {})
  ) as Promise<TodosItem[]>;
/** 显示 / 隐藏浮窗（返回操作后可见状态） */
export const floatToggle = () => invoke<boolean>("float_toggle");
/** 锁定 / 解锁浮窗位置（锁定时禁用拖拽与改大小） */
export const floatSetLocked = (locked: boolean) =>
  invoke<void>("float_set_locked", { locked });
