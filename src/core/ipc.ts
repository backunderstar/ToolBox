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
