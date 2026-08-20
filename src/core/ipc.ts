import { invoke } from "@tauri-apps/api/core";

/** `ping` 命令的返回结构（与 Rust 侧 serde camelCase 对应） */
export interface PingInfo {
  message: string;
  coreVersion: string;
  os: string;
}

/** M0 探针：调用 Rust 核心的 `ping` 命令，验证 IPC 链路。 */
export function ping(): Promise<PingInfo> {
  return invoke<PingInfo>("ping");
}

/** 核心是否已连接（ping 返回 "pong"）：StatusBar/WelcomeView/SettingsView 共用，
 *  避免各处重复判定（浏览器预览环境 ping 失败时由 App 层注入 "preview" 假数据）。 */
export function isCoreConnected(p: PingInfo | null): boolean {
  return p?.message === "pong";
}
