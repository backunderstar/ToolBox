//! ToolBox 核心库：Tauri 主进程入口与命令注册。

mod core;
mod plugins;
mod rpc;

use core::{ai, backup, blog, notes, projects, todos, vault};
use plugins::PluginManager;
use serde::Serialize;
use std::sync::Mutex;

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

/// 调试通道：前端把 console.error / 未捕获错误转发到这里，
/// 打印到终端（`pnpm tauri dev` 的输出中可见，便于排查白屏/编辑器问题）。
#[tauri::command]
fn log_console(msg: String) {
    eprintln!("[webview] {msg}");
}

/// 在系统文件管理器中打开指定路径（Windows：explorer.exe）。
/// 用于设置页"在资源管理器中打开工作区"。
#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // explorer 是 GUI 程序：spawn 后不等待，避免阻塞主线程
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("打开资源管理器失败（{path}）: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("当前平台暂不支持打开文件管理器".to_string())
    }
}

/// 启动应用。
///
/// M1 已注册：`ping` + vault 工作区 + 笔记文件操作 + 文件夹选择对话框。
/// 后续里程碑把 `plugins`（插件管理器）、`rpc`（协议类型）接进来。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 插件命令签名要求 Mutex<PluginManager>（见 plugins/mod.rs 的 State 参数）
        .manage(Mutex::new(PluginManager::default()))
        .manage(blog::PreviewState::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            log_console,
            open_in_explorer,
            vault::vault_get,
            vault::vault_set,
            notes::fs_list,
            notes::fs_list_dir,
            notes::fs_read,
            notes::fs_write,
            notes::fs_create,
            notes::fs_delete,
            notes::fs_rename,
            notes::fs_search,
            plugins::plugins_list,
            plugins::plugins_set_enabled,
            plugins::plugins_reload,
            plugins::plugins_invoke,
            ai::ai_config_get,
            ai::ai_config_set,
            ai::ai_config_clear_key,
            ai::ai_chat,
            ai::ai_test,
            blog::blog_list,
            blog::blog_generate,
            blog::blog_preview_start,
            blog::blog_preview_stop,
            blog::blog_open_folder,
            projects::projects_list,
            projects::projects_create,
            projects::projects_archive,
            projects::projects_unarchive,
            projects::projects_delete,
            projects::projects_files,
            projects::projects_open,
            backup::backup_now_cmd,
            backup::backup_config_get,
            backup::backup_config_set,
            backup::backup_list,
            todos::todos_list,
            todos::todos_add,
            todos::todos_toggle,
            todos::todos_delete,
            todos::todos_clear_done,
            float_toggle,
        ])
        .setup(|app| {
            use tauri::Manager;
            // 后台自动备份线程（随应用常驻，读取配置按间隔执行）
            backup::spawn_auto(app.handle().clone());
            // 桌面半透明浮窗（快速待办）
            create_float_window(app.handle())?;
            // 健壮性：若主窗口位于屏幕外（显示器变更等 Windows 残留），移到屏幕中心
            if let Some(main) = app.get_webview_window("main") {
                if let Ok(pos) = main.outer_position() {
                    if pos.x < -10_000 || pos.y < -10_000 || pos.x > 100_000 || pos.y > 100_000 {
                        eprintln!("[main] 窗口位于屏幕外 ({},{})，已移回中心", pos.x, pos.y);
                        main.center().ok();
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 浮窗窗口标签。
pub const FLOAT_WINDOW: &str = "float";

/// 创建桌面浮窗：无边框、透明、置顶、不进任务栏；位置/大小由 window-state 插件记忆。
fn create_float_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let win = tauri::WebviewWindowBuilder::new(
        app,
        FLOAT_WINDOW,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("ToolBox 快速待办")
    .inner_size(280.0, 420.0)
    .min_inner_size(240.0, 300.0)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .build();
    match &win {
        Ok(w) => {
            eprintln!("[float] 浮窗已创建 label={}", w.label());
            // 透明窗口在 Windows 上可能保持隐藏（等待 WebView 初始化），显式显示
            if let Err(e) = w.show() {
                eprintln!("[float] show 失败: {e}");
            }
        }
        Err(e) => eprintln!("[float] 浮窗创建失败: {e}"),
    }
    win.map(|_| ())
}

/// 显示 / 隐藏浮窗（主窗口顶栏按钮调用）。返回操作后的可见状态。
#[tauri::command]
fn float_toggle(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::Manager;
    let Some(win) = app.get_webview_window(FLOAT_WINDOW) else {
        return Err("浮窗未创建".to_string());
    };
    if win.is_visible().unwrap_or(true) {
        win.hide().map_err(|e| format!("隐藏浮窗失败: {e}"))?;
        Ok(false)
    } else {
        win.show().map_err(|e| format!("显示浮窗失败: {e}"))?;
        win.set_focus().ok();
        Ok(true)
    }
}
