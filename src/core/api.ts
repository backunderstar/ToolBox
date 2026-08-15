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
