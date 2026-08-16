import { invoke } from "@tauri-apps/api/core";

/** 一次提交的元信息（与 Rust core/history.rs 的 serde camelCase 对应） */
export interface CommitInfo {
  hash: string;
  short: string;
  message: string;
  /** unix 秒（git 签名时间） */
  time: number;
  /** 相对上一次提交变更的文件数 */
  files: number;
}

/** 一次提交里单个文件的变化 */
export interface FileChange {
  path: string;
  /** A 新增 / M 修改 / D 删除 / R 重命名 */
  status: "A" | "M" | "D" | "R" | string;
}

/** 版本历史状态 */
export interface HistoryStatus {
  initialized: boolean;
  lastCommit: CommitInfo | null;
  /** 未提交的变更条目数 */
  pending: number;
}

/** 初始化版本历史（幂等）并返回状态 */
export const historyInit = (vault: string) =>
  invoke<HistoryStatus>("history_init", { vault });

/** 当前状态：是否初始化、最近提交、待提交变更数 */
export const historyStatus = (vault: string) =>
  invoke<HistoryStatus>("history_status", { vault });

/** 立即提交全部变更（null = 无变化）；message 为空用时间戳自动信息 */
export const historyCommit = (vault: string, message?: string) =>
  invoke<CommitInfo | null>("history_commit", { vault, message: message ?? null });

/** 提交列表（新 → 旧） */
export const historyList = (vault: string) =>
  invoke<CommitInfo[]>("history_list", { vault });

/** 某次提交变更的文件清单 */
export const historyShow = (vault: string, hash: string) =>
  invoke<FileChange[]>("history_show", { vault, hash });

/** 回滚到指定版本（先自动保存当前状态） */
export const historyRollback = (vault: string, hash: string) =>
  invoke<void>("history_rollback", { vault, hash });
