//! ToolBox 核心库：Tauri 主进程入口与命令注册。

mod core;
mod plugins;
mod rpc;

use serde::Serialize;

/// `ping` 命令的返回结构：用于验证前端 ↔ Rust 核心的 IPC 链路。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingInfo {
    message: &'static str,
    core_version: &'static str,
    os: &'static str,
}

/// M0 探针命令：前端调用 `invoke("ping")` 得到此结果。
#[tauri::command]
fn ping() -> PingInfo {
    PingInfo {
        message: "pong",
        core_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
    }
}

/// 启动应用。
///
/// M0 只注册 `ping`；后续里程碑把 `core`（vault/搜索/AI）、
/// `plugins`（插件管理器）、`rpc`（协议类型）逐步接进来。
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
