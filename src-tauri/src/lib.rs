//! ToolBox 核心库：Tauri 主进程入口与命令注册。
//!
//! 结构整理（2026-09）：本文件只留入口（run/setup/invoke_handler）与探针命令
//! `ping`；命令按域归位——应用设置/托盘/窗口/浮窗在 `core::app`，日志命令在
//! `core::log`，备份/配置命令在各自模块，插件命令在 `plugins::commands`。

mod core;
mod plugins;
mod rpc;

use core::app::{
    app_config_dir, close_behavior, create_float_window, create_tray, ensure_main_visible,
    float_toggle, rebuild_tray, tray_enabled, EXITING, FLOAT_HOTKEY, FLOAT_WINDOW,
};
use core::{backup, vault, workspaces};
use plugins::PluginManager;
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

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
pub fn run() {
    // 浮窗全局快捷键（任何窗口下 Alt+Q 显示/隐藏浮窗，与托盘菜单同一入口 float_toggle）。
    // with_shortcuts 只解析快捷键字符串（失败仅当格式非法，"Alt+Q" 字面量不会触发），
    // 解析失败不 panic：降级为无快捷键插件，浮窗仍可从托盘菜单/顶栏按钮开关。
    let float_hotkey_plugin = {
        use tauri_plugin_global_shortcut::ShortcutState;
        let builder = tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts([FLOAT_HOTKEY])
            .unwrap_or_else(|e| {
                core::log::warn(&format!("浮窗快捷键 {FLOAT_HOTKEY} 解析失败（已禁用）: {e}"));
                tauri_plugin_global_shortcut::Builder::new()
            });
        builder.with_handler(|app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = float_toggle(app.clone());
            }
        }).build()
    };
    tauri::Builder::default()
        // 单实例：第二实例启动时首实例收到回调，把主窗口从托盘恢复到前台
        // （官方插件，Windows 内部即命名 Mutex——与之前手写实现同机制，跨平台可用）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 自动更新：检查/下载/安装新版本（发布包在 GitHub Releases，见 tauri.conf.json updater）
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(float_hotkey_plugin)
        // 注意：托盘/菜单是 Tauri 2 核心能力（tauri::tray / tauri::menu），无需额外插件
        // 插件命令签名要求 Mutex<PluginManager>（见 plugins/mod.rs 的 State 参数）
        .manage(Mutex::new(PluginManager::default()))
        .on_window_event(|window, event| {
            // 主窗口关闭：按设置分流——
            // - EXITING（托盘退出）或未启用托盘或 closeBehavior=quit → 放行退出
            // - 否则（托盘常驻）→ 仅 prevent（不 hide）：hide 由前端在关闭询问/直接
            //   最小化流程里执行，避免前端弹询问框时窗口已被隐藏（8/30 实测时序坑）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !EXITING.load(std::sync::atomic::Ordering::SeqCst) {
                    let quit =
                        !tray_enabled(window.app_handle()) || close_behavior(window.app_handle()) == "quit";
                    if quit {
                        // 「退出应用」模式：顺带关闭浮窗（否则主窗口关闭后浮窗还在，应用不退出）
                        if let Some(f) = window.app_handle().get_webview_window(FLOAT_WINDOW) {
                            let _ = f.close();
                        }
                    } else {
                        api.prevent_close();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            core::log::log_console,
            core::app::open_in_explorer,
            vault::vault_get,
            vault::vault_set,
            // 多工作区（工作区根目录 + 当前工作区切换；vault 是其单工作区回退）
            workspaces::workspace_get,
            workspaces::workspace_set_root,
            workspaces::workspace_switch,
            workspaces::workspace_create,
            // 宿主文件服务（vault 内文件列表/读写/增删改；插件核心 API 与宿主共用）
            core::files::files_list,
            core::files::files_read,
            core::files::files_write,
            core::files::files_create,
            core::files::files_mkdir,
            core::files::files_delete,
            core::files::files_rename,
            core::files::files_move,
            core::files::files_copy,
            // 插件命令在 plugins::commands 定义（tauri 宏在定义模块生成
            // __cmd__* 辅助项，路径需指向定义模块；非命令项仍走 plugins::*）
            plugins::commands::plugins_list,
            plugins::commands::plugins_set_enabled,
            plugins::commands::plugins_reload,
            plugins::commands::plugins_install_deps,
            plugins::commands::plugins_uninstall,
            plugins::commands::plugins_reinstall_core,
            plugins::commands::plugins_removed_core,
            plugins::commands::plugins_install,
            plugins::commands::plugins_export,
            plugins::commands::plugins_read_file,
            plugins::commands::plugins_invoke,
            plugins::commands::plugin_call,
            plugins::commands::search_all,
            plugins::commands::plugins_dir_get,
            plugins::commands::plugins_dir_set,
            plugins::commands::plugin_log,
            // 备份/配置/设置/日志/浮窗命令归位到各自域模块（见模块头注释）
            core::backup::cmd_backup_now,
            core::backup::cmd_backup_config_get,
            core::backup::cmd_backup_config_set,
            core::backup::cmd_backup_list,
            core::backup::cmd_backup_restore,
            core::config::config_export,
            core::config::config_import,
            core::app::app_settings_get,
            core::app::app_settings_set,
            core::app::tray_set_enabled,
            core::log::logs_path,
            core::log::logs_tail,
            core::log::logs_clear,
            core::log::log_level_set,
            core::app::float_toggle,
            core::app::float_set_locked,
            core::app::set_window_caption_color,
        ])
        .setup(|app| {
            // 运行日志目录（%APPDATA%/com.toolbox.desktop/logs/）；失败则日志仅终端
            if let Ok(dir) = app_config_dir(app.handle()) {
                core::log::init(&dir);
                // 应用持久化的日志级别（app.json logLevel；缺省 info）
                if let Some(lv) = core::app::load_app_settings(app.handle())
                    .get("logLevel")
                    .and_then(|v| v.as_str())
                {
                    core::log::set_level(lv);
                }
            }
            // 首启初始化：plugins.json 不存在 → 全部插件默认关闭（core-example
            // 显式进 disabled；外部插件按 enabled 集合，空 = 全关）。dev 一致执行。
            plugins::manager::ensure_initial_state(app.handle());
            // 打包版：把安装包资源里的核心插件部署到 %APPDATA%（dev 由 build:core 管理）。
            // 首次启动/升级时递归复制 DLL 是重 IO，放后台线程避免阻塞窗口创建与首帧
            // 渲染。部署只写插件目录、无返回值供后续使用（插件扫描发生在前端调
            // plugins_list 时），即使竞态（用户启动后立刻打开插件页且部署未完成）也
            // 只表现为缺插件，reload 即恢复，不破坏正确性。
            #[cfg(not(dev))]
            {
                // 捆绑 Python 运行时部署（先于核心插件部署，让下方预热线程的 2s 等待
                // 覆盖复制 IO；即使未完成也只表现为插件回落系统 python/报缺解释器）
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    plugins::ensure_bundled_python(&h);
                });
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    plugins::ensure_core_plugins(&h);
                });
                // 随包外部插件（resources/bundled-plugins → 全局插件目录顶层）
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    plugins::ensure_bundled_plugins(&h);
                });
            }
            // 插件预热：首次 plugins_list 的 refresh（扫描插件目录 + 启动启用插件）
            // 是重活，启动后后台提前执行，让用户首次打开应用/插件页时列表立即可用。
            // 与命令层同一 ensure_refreshed（快照检测，幂等——若用户先触发过
            // plugins_list，这里快照无变化直接跳过）。release 下等 2s 给核心插件
            // 部署线程留完成时间；部署未完成扫到不完整 _core 也只临时缺插件，
            // 用户调用时快照变化会重新 refresh 自愈。
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2000));
                    let Ok(vault) = core::vault::vault_get(h.clone()) else {
                        return;
                    };
                    let Some(path) = vault.path else {
                        return; // vault 未配置：没有可预热的插件列表
                    };
                    let state = h.state::<Mutex<plugins::PluginManager>>();
                    let Ok(mut m) = state.lock() else {
                        return;
                    };
                    if let Err(e) = m.ensure_refreshed(&h, &path) {
                        core::log::warn(&format!("[plugin] 预热刷新失败: {e}"));
                    }
                    drop(m);
                    // 预热后重建托盘（插件动作段）；失败只记日志不阻断
                    if let Err(e) = rebuild_tray(&h) {
                        core::log::warn(&format!("[tray] 重建托盘失败: {e}"));
                    }
                });
            }
            // 插件列表变化（启停/卸载/重装）→ 前端 plugins-changed → 重建托盘插件动作段
            {
                let h = app.handle().clone();
                let h2 = h.clone();
                let _ = tauri::Listener::listen(&h, "plugins-changed", move |_| {
                    if let Err(e) = rebuild_tray(&h2) {
                        core::log::warn(&format!("[tray] 重建托盘失败: {e}"));
                    }
                });
            }
            // 插件事件桥：进程插件事件 → 前端 plugin-event 事件
            plugins::events::spawn_event_forwarder(app.handle().clone());
            // 原生插件事件回调需要 AppHandle（host 回调）
            plugins::native::init_host_app(app.handle().clone());
            // 系统托盘（关窗常驻后台；设置可关，trayEnabled=false 时跳过创建）
            if tray_enabled(app.handle()) {
                create_tray(app.handle())?;
            }
            // 桌面半透明浮窗（快速待办）
            create_float_window(app.handle())?;
            // 主窗口屏幕外自愈：立即检测 + 延迟复检（window-state 插件在 setup 后
            // 才恢复窗口状态，可能把窗口放到屏幕外/异常尺寸）
            ensure_main_visible(app.handle());
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                ensure_main_visible(&h);
            });
            // 自动备份后台线程（宿主内嵌，进程内单例；配置存 %APPDATA%/backup.json）
            if let Ok(dir) = app_config_dir(app.handle()) {
                backup::spawn_auto(dir);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
