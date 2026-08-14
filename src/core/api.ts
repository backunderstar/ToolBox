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
