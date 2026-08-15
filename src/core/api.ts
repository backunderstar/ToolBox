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
}

export interface SearchHit {
  path: string;
  filename: string;
  snippet: string;
}

/** 插件信息（与 Rust PluginInfo 对应，serde camelCase） */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  runtime: "webview" | "process";
  /** webview 插件入口文件（相对插件目录） */
  entry: string | null;
  enabled: boolean;
  status: "error" | "ready" | "stopped";
  error: string | null;
  commands: string[];
}

/* ---- IPC 封装 ---- */

export const ping = () => invoke<PingInfo>("ping");

export const vaultGet = () => invoke<VaultSettings>("vault_get");
export const vaultSet = (path: string) =>
  invoke<void>("vault_set", { path });

export const fsList = (vault: string) =>
  invoke<FileEntry[]>("fs_list", { vault });
/** 列出 vault 指定目录下的全部条目（含非 .md 文件，供 JSON 数据枚举） */
export const fsListDir = (vault: string, dir: string) =>
  invoke<FileEntry[]>("fs_list_dir", { vault, dir });
export const fsRead = (vault: string, rel: string) =>
  invoke<string>("fs_read", { vault, rel });
export const fsWrite = (vault: string, rel: string, content: string) =>
  invoke<void>("fs_write", { vault, rel, content });
export const fsCreate = (vault: string, rel: string) =>
  invoke<void>("fs_create", { vault, rel });
export const fsDelete = (vault: string, rel: string) =>
  invoke<void>("fs_delete", { vault, rel });
export const fsRename = (vault: string, from: string, to: string) =>
  invoke<void>("fs_rename", { vault, from, to });
export const fsSearch = (vault: string, query: string) =>
  invoke<SearchHit[]>("fs_search", { vault, query });

/* ---- 插件系统 ---- */

export const pluginsList = (vault: string) =>
  invoke<PluginInfo[]>("plugins_list", { vault });
export const pluginsSetEnabled = (vault: string, id: string, enabled: boolean) =>
  invoke<void>("plugins_set_enabled", { vault, id, enabled });
export const pluginsReload = (vault: string, id: string) =>
  invoke<void>("plugins_reload", { vault, id });
export const pluginsInvoke = (
  vault: string,
  id: string,
  command: string,
  args: unknown
) => invoke<unknown>("plugins_invoke", { vault, id, command, args });

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
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const aiConfigGet = () => invoke<AiConfig>("ai_config_get");
export const aiConfigSet = (config: AiConfig) =>
  invoke<void>("ai_config_set", { config });
export const aiConfigClearKey = () => invoke<void>("ai_config_clear_key");
export const aiChat = (messages: ChatMessage[]) =>
  invoke<string>("ai_chat", { messages });
export const aiTest = () => invoke<string>("ai_test");

/* ---- M7 博客 ---- */

export interface PostMeta {
  path: string;
  title: string;
  date: string;
  tags: string[];
  status: string;
}

export interface BlogListResult {
  posts: PostMeta[];
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
}

export const backupConfigGet = () => invoke<BackupConfig>("backup_config_get");
export const backupConfigSet = (config: BackupConfig) =>
  invoke<void>("backup_config_set", { config });
export const backupNow = (vault: string) => invoke<BackupInfo>("backup_now_cmd", { vault });
export const backupList = (vault: string) => invoke<BackupEntry[]>("backup_list", { vault });

/* ---- 浮窗快速待办 ---- */

export interface TodosItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

export const todosList = () => invoke<TodosItem[]>("todos_list");
export const todosAdd = (text: string) => invoke<TodosItem[]>("todos_add", { text });
export const todosToggle = (id: string) => invoke<TodosItem[]>("todos_toggle", { id });
export const todosDelete = (id: string) => invoke<TodosItem[]>("todos_delete", { id });
export const todosClearDone = () => invoke<TodosItem[]>("todos_clear_done");
/** 显示 / 隐藏浮窗（返回操作后可见状态） */
export const floatToggle = () => invoke<boolean>("float_toggle");
/** 锁定 / 解锁浮窗位置（锁定时禁用拖拽与改大小） */
export const floatSetLocked = (locked: boolean) =>
  invoke<void>("float_set_locked", { locked });
