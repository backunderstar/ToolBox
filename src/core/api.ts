import { invoke } from "@tauri-apps/api/core";

/* ---- 类型（与 Rust 侧 serde camelCase 对应） ---- */

export interface VaultSettings {
  path: string | null;
}

export interface FileEntry {
  name: string;
  path: string; // vault 相对路径，/ 分隔
  isDir: boolean;
  /** 文件字节数（目录为 null） */
  size: number | null;
  /** 修改时间（UNIX 毫秒整数；搜索/排序用） */
  mtime: number | null;
}

export interface SearchHit {
  path: string;
  filename: string;
  snippet: string;
  /** 文件修改时间（UNIX 毫秒）：宿主按"最近修改"排序结果（阶段内降序） */
  mtime?: number;
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

/** 宿主外壳动作（Rust ActionDecl 对应）：顶栏图标按钮 / 托盘菜单项 */
export interface PluginAction {
  id: string;
  label: string;
  icon: string;
  /** 是否显示到顶栏 */
  topbar: boolean;
  /** 是否显示到托盘菜单 */
  tray: boolean;
}

/** 插件主题声明（与 Rust ThemeDecl 对应）：非空时该插件是主题包 */
export interface PluginThemeDecl {
  /** 亮/暗基础（驱动 tokens.css 的 [data-theme]） */
  base: "light" | "dark";
  /** 令牌覆盖（CSS 变量名 → 值） */
  tokens: Record<string, string>;
  /** 可选 CSS 覆盖文件（相对插件目录）；切换主题即移除 */
  css: string | null;
  /** 预览色板（选择器色块：bg/accent/fg，至多 3 色）；缺省从 tokens 推断 */
  preview: string[] | null;
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
  /** 插件自带前端入口（相对插件目录；null = 无自带前端，声明 nav 也只会显示占位页） */
  ui: string | null;
  /** 插件声明的导航入口（启用时并入侧边栏） */
  nav: PluginNav[];
  /** 主题声明（皮肤插件）：非空时本插件是主题包，启用后并入主题选择器 */
  theme: PluginThemeDecl | null;
  /** 插件目录存在 requirements.txt（显示"安装依赖"按钮，用捆绑 Python 的 pip 装到 vendor/） */
  hasDeps: boolean;
  /** 宿主外壳动作（顶栏图标按钮 / 托盘菜单项） */
  actions: PluginAction[];
  /** 设置页插件段入口（相对插件目录；null = 无自定义设置面板） */
  settings: string | null;
}

/** 插件运行时 → 界面标签（插件页 / 概览页共用，避免各组件重复定义） */
export const RUNTIME_LABEL: Record<string, string> = {
  webview: "JS",
  process: "Python",
  native: "原生",
};

/* ---- IPC 封装 ---- */

export const vaultGet = () => invoke<VaultSettings>("vault_get");
export const vaultSet = (path: string) => invoke<void>("vault_set", { path });

/* ---- 应用设置（%APPDATA%/com.toolbox.desktop/app.json 通用键值） ---- */

export const appSettingsGet = () => invoke<Record<string, unknown>>("app_settings_get");
export const appSettingsSet = (key: string, value: unknown) =>
  invoke<void>("app_settings_set", { key, value });

/* ---- 宿主文件服务（vault 内文件列表/读写/增删改；系统级框架能力，
   插件 webview 桥 fs.readText/writeText 与宿主数据层共用同一封装） ---- */

/** 枚举 vault 内目录（dir 为空 = vault 根；忽略隐藏/工具目录） */
export const fsList = (vault: string, dir = "") =>
  invoke<FileEntry[]>("files_list", { vault, dir });
export const fsRead = (vault: string, rel: string) =>
  invoke<string>("files_read", { vault, rel });
export const fsWrite = (vault: string, rel: string, content: string) =>
  invoke<void>("files_write", { vault, rel, content });
export const fsCreate = (vault: string, rel: string) =>
  invoke<void>("files_create", { vault, rel });
export const fsDelete = (vault: string, rel: string) =>
  invoke<void>("files_delete", { vault, rel });
export const fsRename = (vault: string, from: string, to: string) =>
  invoke<void>("files_rename", { vault, from, to });

/** 聚合搜索：文件全文 + 启用的搜索提供者插件命中（source 字段标记来源） */
export const searchAll = (vault: string, query: string) =>
  invoke<SearchHit[]>("search_all", { vault, query });

/* ---- 插件系统 ---- */

export const pluginsList = (vault: string) => invoke<PluginInfo[]>("plugins_list", { vault });
export const pluginsSetEnabled = (vault: string, id: string, enabled: boolean) =>
  invoke<void>("plugins_set_enabled", { vault, id, enabled });
export const pluginsReload = (vault: string, id: string) =>
  invoke<void>("plugins_reload", { vault, id });
/** 安装插件依赖：用捆绑 Python 的 pip 把 requirements.txt 装进 <插件>/vendor/（需有网）；
 *  返回 pip 输出尾部；成功后应重载插件生效 */
export const pluginsInstallDeps = (vault: string, id: string) =>
  invoke<string>("plugins_install_deps", { vault, id });
export const pluginsUninstall = (vault: string, id: string) =>
  invoke<void>("plugins_uninstall", { vault, id });
/** 重新安装已卸载的核心插件（从随应用分发的资源恢复 DLL + 目录） */
export const pluginsReinstallCore = (vault: string, id: string) =>
  invoke<void>("plugins_reinstall_core", { vault, id });
/** 已卸载的核心插件 id 列表（前端展示"重新安装"入口） */
export const pluginsRemovedCore = () => invoke<string[]>("plugins_removed_core");
/** 界面安装插件（通用 runtime）：source = .zip 包路径或插件目录路径；kind = "zip" | "dir"。
 *  按清单 runtime 部署（native → _core/；webview/process/主题皮肤 → plugins/）。 */
export const pluginsInstall = (vault: string, source: string, kind: string) =>
  invoke<string>("plugins_install", { vault, source, kind });
/** 导出插件为 .zip 插件包（分享/备份）：dest = 保存路径；返回导出文件路径 */
export const pluginsExport = (vault: string, id: string, dest: string) =>
  invoke<string>("plugins_export", { vault, id, dest });
/** 当前生效的全局插件目录（自定义或默认 %APPDATA%） */
export const pluginsDirGet = () => invoke<string>("plugins_dir_get");
/** 设置全局插件目录（自动迁移现有插件，旧目录进回收站）；传空恢复默认 */
export const pluginsDirSet = (path: string) => invoke<string>("plugins_dir_set", { path });
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

/** 设置窗口标题栏近似色（主题联动）：color 为 CSS 十六进制 "#RRGGBB"；
 *  传 null 恢复系统默认；非 Windows 平台静默忽略。 */
export const setWindowCaptionColor = (color: string | null) =>
  invoke<void>("set_window_caption_color", { color });

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

/* ---- 配置导入导出（换机迁移；core::config） ---- */

export interface ConfigBundle {
  format: string;
  version: number;
  exportedAt: string;
  appVersion: string;
  /** localStorage 段（键 → 原始字符串，写回保真） */
  frontend: Record<string, string>;
  /** 宿主侧段（插件启停/已卸载核心/备份/AI 设置等） */
  backend: Record<string, unknown>;
}

/** 导出配置到指定文件（前端 localStorage 段 + 宿主配置段合成；不含 API Key 与 plugins_dir） */
export const configExport = (path: string, frontend: Record<string, string>) =>
  invoke<void>("config_export", { path, frontend });

/** 导入配置：宿主侧已写回；返回完整配置包供前端写回 localStorage */
export const configImport = (path: string) => invoke<ConfigBundle>("config_import", { path });

/* ---- 浮窗（宿主独立窗口，内容 = 插件自带前端） ---- */

/** 显示 / 隐藏浮窗（返回操作后可见状态） */
export const floatToggle = () => invoke<boolean>("float_toggle");
/** 锁定 / 解锁浮窗位置（锁定时禁用拖拽与改大小） */
export const floatSetLocked = (locked: boolean) => invoke<void>("float_set_locked", { locked });
