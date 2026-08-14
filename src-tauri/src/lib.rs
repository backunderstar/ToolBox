//! ToolBox 核心库：Tauri 主进程入口与命令注册。

mod core;
mod plugins;
mod rpc;

use core::{notes, vault};
use serde::Serialize;

/// `ping` 命令的返回结构：用于验证前端 ↔ Rust 核心的 IPC 链路。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingInfo {
    message: &'static str,
    core_version: &'static str,
    os: &'static str,
}

/// 探针命令：前端调用 `invoke("ping")` 得到此结果。
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
/// M1 已注册：`ping` + vault 工作区 + 笔记文件操作 + 文件夹选择对话框。
/// 后续里程碑把 `plugins`（插件管理器）、`rpc`（协议类型）接进来。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            ping,
            vault::vault_get,
            vault::vault_set,
            notes::fs_list,
            notes::fs_read,
            notes::fs_write,
            notes::fs_create,
            notes::fs_delete,
            notes::fs_rename,
            notes::fs_search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
