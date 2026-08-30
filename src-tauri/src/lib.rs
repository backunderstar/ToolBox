//! ToolBox 核心库：Tauri 主进程入口与命令注册。

mod core;
mod plugins;
mod rpc;

use core::{backup, vault};
use plugins::PluginManager;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// 退出标志：托盘"退出"置位后，窗口关闭事件不再拦截（放行真正退出）。
static EXITING: AtomicBool = AtomicBool::new(false);

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
    core::log::error(&format!("[webview] {msg}"));
}

/// 在系统文件管理器中打开指定路径（Windows：explorer.exe）。
/// 用于设置页"在资源管理器中打开工作区"。
#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // 只允许打开真实存在的目录；explorer 会把 http:// / shell: 前缀转发
        // 给浏览器/特殊文件夹，不能把任意字符串交给它
        let p = std::path::PathBuf::from(&path);
        if !p.is_dir() {
            return Err(format!("路径不存在或不是目录: {path}"));
        }
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

/// 定位应用配置目录（%APPDATA%/com.toolbox.desktop，不存在则创建）。
fn app_config_dir(app: &tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/* ---- 应用设置（%APPDATA%/com.toolbox.desktop/app.json，通用键值） ---- */

fn app_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("app.json"))
}

fn load_app_settings(app: &tauri::AppHandle) -> serde_json::Map<String, serde_json::Value> {
    let Ok(p) = app_settings_path(app) else {
        return serde_json::Map::new();
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// 关闭主窗口的行为："tray"（默认）= 最小化到托盘常驻；"quit" = 退出应用。
fn close_behavior(app: &tauri::AppHandle) -> String {
    load_app_settings(app)
        .get("closeBehavior")
        .and_then(|v| v.as_str())
        .unwrap_or("tray")
        .to_string()
}

/// 读取应用设置（整个 map，前端设置页用）。
#[tauri::command]
fn app_settings_get(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::Value::Object(load_app_settings(&app))
}

/// 写入单个设置键（原子写，与 plugins.json 同风格防损坏）。
#[tauri::command]
fn app_settings_set(
    app: tauri::AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    write_app_setting(&app, &key, value)
}

fn write_app_setting(
    app: &tauri::AppHandle,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let mut map = load_app_settings(app);
    map.insert(key.to_string(), value);
    let p = app_settings_path(app)?;
    let raw =
        serde_json::to_string_pretty(&serde_json::Value::Object(map)).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存设置失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存设置失败: {e}"))
}

/// 是否启用系统托盘图标（app.json trayEnabled，默认 true）。
fn tray_enabled(app: &tauri::AppHandle) -> bool {
    load_app_settings(app)
        .get("trayEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// 设置托盘图标开关：运行时显示/隐藏托盘（设置页开关调用）。
#[tauri::command]
fn tray_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    write_app_setting(&app, "trayEnabled", serde_json::json!(enabled))?;
    if enabled {
        match app.tray_by_id("main-tray") {
            // 应用启动时已创建：恢复显示
            Some(tray) => tray.set_visible(true).map_err(|e| format!("显示托盘失败: {e}"))?,
            // 启动时被设置关闭而未创建：现在补建
            None => create_tray(&app).map_err(|e| format!("创建托盘失败: {e}"))?,
        }
    } else if let Some(tray) = app.tray_by_id("main-tray") {
        // 隐藏托盘图标（TrayIcon 无 remove/close 公开方法，资源随 AppHandle 生命周期）
        tray.set_visible(false).map_err(|e| format!("隐藏托盘失败: {e}"))?;
        // 托盘被关闭后主窗口若不可见会无法恢复——强制显示主窗口
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
        }
    }
    Ok(())
}

/* ---- 自动备份（宿主内嵌 core::backup；原 core-backup 插件命令） ---- */

/// 设置窗口标题栏近似色（主题联动，M5 增强）：
/// 前端在应用主题时把画布背景色（--bg 计算值）传过来，标题栏背景跟随主题
/// 大致色相变化（如暖色主题 → 米色标题栏、午夜蓝主题 → 深蓝标题栏）。
/// 实现：Windows 11 的 DwmSetWindowAttribute(DWMWA_CAPTION_COLOR)；不支持或
/// 调用失败时静默忽略（系统仍按亮/暗模式渲染标题栏，行为不劣化）。
/// color 传 null 恢复系统默认；非 Windows 平台为 no-op。
#[tauri::command]
fn set_window_caption_color(window: tauri::Window, color: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

        // DWMWA_CAPTION_COLOR = 35（Windows 11 22000+）
        const DWMWA_CAPTION_COLOR: u32 = 35;
        // DWMWA_COLOR_DEFAULT：恢复系统默认标题栏颜色
        const DWMWA_COLOR_DEFAULT: u32 = 0xFFFF_FFFF;

        let dwm_color: u32 = match color {
            Some(hex) => parse_hex_color(&hex)?,
            None => DWMWA_COLOR_DEFAULT,
        };
        let Ok(handle) = window.window_handle() else {
            return Ok(());
        };
        let RawWindowHandle::Win32(h) = handle.as_raw() else {
            return Ok(());
        };
        let hwnd = h.hwnd.get() as *mut std::ffi::c_void;
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_CAPTION_COLOR,
                &dwm_color as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, color);
    }
    Ok(())
}

/// 解析 CSS 十六进制颜色 "#RRGGBB" → Windows COLORREF（0x00BBGGRR）。
/// 仅 Windows 标题栏近似色使用；非 Windows 目标加 cfg 避免 dead_code 警告。
#[cfg(target_os = "windows")]
fn parse_hex_color(s: &str) -> Result<u32, String> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("非法标题栏颜色（需 #RRGGBB）: {s}"));
    }
    let r = u32::from_str_radix(&h[0..2], 16).map_err(|_| "非法颜色".to_string())?;
    let g = u32::from_str_radix(&h[2..4], 16).map_err(|_| "非法颜色".to_string())?;
    let b = u32::from_str_radix(&h[4..6], 16).map_err(|_| "非法颜色".to_string())?;
    Ok((b << 16) | (g << 8) | r)
}

/* ---- 自动备份（宿主内嵌 core::backup；原 core-backup 插件命令） ---- */

#[tauri::command]
async fn backup_now(app: tauri::AppHandle, vault: String) -> Result<backup::BackupInfo, String> {
    // 安全（S1c）：备份会读取并复制 vault 全量内容，作用域必须绑定已配置工作区
    core::vault::ensure_vault_matches(&app, &vault)?;
    let cfg = app_config_dir(&app)?;
    // 全量复制是重 IO：放阻塞线程池，避免冻结主线程（同步命令在主线程执行）
    tauri::async_runtime::spawn_blocking(move || backup::backup_now_cmd(&cfg, &vault))
        .await
        .map_err(|e| format!("备份任务异常: {e}"))?
}

#[tauri::command]
fn backup_config_get(app: tauri::AppHandle) -> Result<backup::BackupConfig, String> {
    let cfg = app_config_dir(&app)?;
    Ok(backup::backup_config_get(&cfg))
}

#[tauri::command]
fn backup_config_set(
    app: tauri::AppHandle,
    config: backup::BackupConfig,
) -> Result<(), String> {
    let cfg = app_config_dir(&app)?;
    backup::backup_config_set(&cfg, config)
}

#[tauri::command]
async fn backup_list(app: tauri::AppHandle, vault: String) -> Result<Vec<backup::BackupEntry>, String> {
    core::vault::ensure_vault_matches(&app, &vault)?;
    // 递归 stat 全部备份目录是重 IO：放阻塞线程池
    tauri::async_runtime::spawn_blocking(move || backup::backup_list(&vault))
        .await
        .map_err(|e| format!("读取备份列表异常: {e}"))
}

#[tauri::command]
async fn backup_restore(
    app: tauri::AppHandle,
    vault: String,
    name: String,
) -> Result<backup::BackupInfo, String> {
    // 恢复会向 vault 覆盖写入，同样绑定已配置工作区
    core::vault::ensure_vault_matches(&app, &vault)?;
    let cfg = app_config_dir(&app)?;
    // 恢复 = 全量复制 vault（两遍）：放阻塞线程池
    tauri::async_runtime::spawn_blocking(move || backup::restore_backup(&cfg, &vault, &name))
        .await
        .map_err(|e| format!("恢复任务异常: {e}"))?
}

/* ---- 配置导入导出（换机迁移；core::config） ---- */

/// 导出配置到指定文件（前端传 localStorage 段，宿主合并自己的配置）。
#[tauri::command]
fn config_export(
    app: tauri::AppHandle,
    path: String,
    frontend: serde_json::Value,
) -> Result<(), String> {
    core::config::export_config(&app, &path, frontend)
}

/// 导入配置：宿主侧已写回；返回完整配置包供前端写回 localStorage。
#[tauri::command]
fn config_import(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    core::config::import_config(&app, &path)
}

/// 启动应用。
///
/// M1 已注册：`ping` + vault 工作区 + 笔记文件操作 + 文件夹选择对话框。
/// 后续里程碑把 `plugins`（插件管理器）、`rpc`（协议类型）接进来。
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
                if window.label() == "main" && !EXITING.load(Ordering::SeqCst) {
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
            log_console,
            open_in_explorer,
            vault::vault_get,
            vault::vault_set,
            // 宿主文件服务（vault 内文件列表/读写/增删改；插件核心 API 与宿主共用）
            core::files::files_list,
            core::files::files_read,
            core::files::files_write,
            core::files::files_create,
            core::files::files_delete,
            core::files::files_rename,
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
            backup_now,
            backup_config_get,
            backup_config_set,
            backup_list,
            backup_restore,
            config_export,
            config_import,
            app_settings_get,
            app_settings_set,
            tray_set_enabled,
            float_toggle,
            float_set_locked,
            set_window_caption_color,
        ])
        .setup(|app| {
            // 运行日志目录（%APPDATA%/com.toolbox.desktop/logs/）；失败则日志仅终端
            if let Ok(dir) = app_config_dir(app.handle()) {
                core::log::init(&dir);
            }
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
                core::backup::spawn_auto(dir);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 浮窗窗口标签。
pub const FLOAT_WINDOW: &str = "float";
/// 浮窗全局快捷键（任何窗口下显示/隐藏浮窗）。
pub const FLOAT_HOTKEY: &str = "Alt+Q";

/// 主窗口屏幕外自愈：若窗口位于明显屏幕外（显示器变更/window-state 残留），移到屏幕中心。
fn ensure_main_visible(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(pos) = main.outer_position() {
        if pos.x < -10_000 || pos.y < -10_000 || pos.x > 100_000 || pos.y > 100_000 {
            core::log::warn(&format!(
                "[main] 窗口位于屏幕外 ({},{})，已移回中心",
                pos.x, pos.y
            ));
            main.center().ok();
            main.set_focus().ok();
        }
    }
}

/// 系统托盘：图标 + 菜单（显示主窗口 / 显示隐藏浮窗 / 插件动作段 / 退出）+ 单击切换主窗口。
/// 插件动作段由已启用插件 manifest `actions[].tray` 动态构建（rebuild_tray），
/// 插件启停变化经前端 `plugins-changed` 事件重建。
fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show_main = MenuItem::with_id(app, "tray-show-main", "显示主窗口", true, None::<&str>)?;
    let toggle_float = MenuItem::with_id(app, "tray-toggle-float", "显示/隐藏浮窗", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 ToolBox", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_main, &toggle_float, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("ToolBox")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(handle_tray_event)
        .on_tray_icon_event(|tray, event| {
            // 单击左键：切换主窗口显示/隐藏
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                }
            }
        });
    // 图标缺失时不 panic（如调试构建无图标）：托盘降级为无图标
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// 托盘菜单事件：固定项 + 插件动作项（`tray-plugin:<pluginId>:<actionId>`）。
fn handle_tray_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id.as_ref();
    match id {
        "tray-show-main" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        "tray-toggle-float" => {
            let _ = float_toggle(app.clone());
        }
        "tray-quit" => {
            EXITING.store(true, Ordering::SeqCst);
            // 优雅退出（修 8/30 的 Error 1412）：不强制 `app.exit`——先让窗口真正
            // 关闭，WebView2 随窗口正常清理，run 循环在全部窗口关闭后自然退出。
            // `app.exit` 会强制销毁 WebView 环境，窗口析构时注销窗口类失败
            // （Chromium "Failed to unregister class Chrome_WidgetWin_0. Error = 1412"）。
            for label in ["main", FLOAT_WINDOW] {
                if let Some(w) = app.get_webview_window(label) {
                    let _ = w.close();
                }
            }
        }
        _ => {
            // 插件托盘动作：与前端 triggerPluginAction 同构（事件通道 + 命令通道）
            if let Some(rest) = id.strip_prefix("tray-plugin:") {
                let mut parts = rest.splitn(2, ':');
                if let (Some(pid), Some(action)) = (parts.next(), parts.next()) {
                    plugin_shell_action(app, pid.to_string(), action.to_string(), "tray");
                }
            }
        }
    }
}

/// 重建托盘菜单（含插件动作段）：插件启停/卸载/重装后调用。
/// 托盘被设置关闭（trayEnabled=false）时 no-op。
fn rebuild_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    if !tray_enabled(app) {
        return Ok(());
    }
    use tauri::menu::{Menu, MenuItem};
    let show_main = MenuItem::with_id(app, "tray-show-main", "显示主窗口", true, None::<&str>)?;
    let toggle_float = MenuItem::with_id(app, "tray-toggle-float", "显示/隐藏浮窗", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 ToolBox", true, None::<&str>)?;
    // 插件段：已启用插件声明的 tray 动作（平铺，label = "插件名：动作名"）
    let mut plugin_items: Vec<tauri::menu::MenuItem<tauri::Wry>> = Vec::new();
    if let Ok(m) = app.state::<Mutex<PluginManager>>().lock() {
        for rec in m.records.iter() {
            if !m.plugin_enabled(&rec.manifest.id) {
                continue;
            }
            for a in rec.manifest.actions.iter().filter(|a| a.tray) {
                let label = format!("{}：{}", rec.manifest.name, a.label);
                if let Ok(it) = tauri::menu::MenuItem::with_id(
                    app,
                    format!("tray-plugin:{}:{}", rec.manifest.id, a.id),
                    &label,
                    true,
                    None::<&str>,
                ) {
                    plugin_items.push(it);
                }
            }
        }
    }
    let mut all: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&show_main, &toggle_float];
    all.extend(plugin_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>));
    all.push(&quit);
    let menu = Menu::with_items(app, &all)?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

/// 插件外壳动作（托盘/顶栏/设置页）统一交互（与前端 triggerPluginAction 同构）：
/// ① 发 `plugin-event` 事件 `action`（插件 UI api.on("action") 订阅）
/// ② 非 webview 插件调约定命令 `plugin.action {action, source}`（后台线程执行）。
fn plugin_shell_action(app: &tauri::AppHandle, plugin_id: String, action: String, source: &str) {
    use tauri::Emitter;
    let app = app.clone();
    let _ = app.emit(
        "plugin-event",
        crate::plugins::events::PluginEvent {
            plugin_id: plugin_id.clone(),
            event: "action".into(),
            data: serde_json::json!({ "action": action, "source": source }),
        },
    );
    let source = source.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        use plugins::manifest::PluginRuntime;
        let Ok(Some(vault)) = crate::core::vault::read_vault_path(&app) else {
            return;
        };
        let _ = vault;
        let state = app.state::<Mutex<PluginManager>>();
        let Ok(mut m) = state.lock() else {
            return;
        };
        let Some(rec) = m.records.iter().find(|r| r.manifest.id == plugin_id) else {
            return;
        };
        if !m.plugin_enabled(&rec.manifest.id) || rec.manifest.runtime == PluginRuntime::Webview {
            return; // webview 插件命令在宿主侧无分发，由事件通道响应
        }
        let _ = m.invoke(
            &plugin_id,
            "plugin.action",
            serde_json::json!({ "action": action, "source": source }),
        );
    });
}

/// 浮窗可见性记忆：%APPDATA%/com.toolbox.desktop/float.json。
/// 上次隐藏后启动应用不应再弹出浮窗（window-state 只记忆位置/尺寸）。
fn float_visible_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("float.json"))
}

fn read_float_visible(app: &tauri::AppHandle) -> bool {
    let Ok(p) = float_visible_path(app) else {
        return true;
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("visible").and_then(|x| x.as_bool()))
        .unwrap_or(true)
}

fn write_float_visible(app: &tauri::AppHandle, visible: bool) {
    if let Ok(p) = float_visible_path(app) {
        // 原子写：临时文件 + rename（与其他配置一致，防崩溃留损坏 JSON）
        let raw = format!("{{\"visible\": {visible}}}");
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, &raw).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

/// 创建桌面浮窗：无边框、透明、**不置顶**（桌面层小组件，不遮挡其他窗口）；
/// 位置/大小由 window-state 插件记忆；初始可见性按上次状态恢复。
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
    .skip_taskbar(true)
    .resizable(true)
    .build();
    match &win {
        Ok(w) => {
            core::log::info(&format!("[float] 浮窗已创建 label={}", w.label()));
            // 透明窗口在 Windows 上可能保持隐藏（等待 WebView 初始化），
            // 按记忆的可见性显式显示/隐藏（上次隐藏则不打扰）
            let visible = read_float_visible(app);
            if visible {
                if let Err(e) = w.show() {
                    core::log::error(&format!("[float] show 失败: {e}"));
                }
            } else {
                let _ = w.hide();
            }
            // 置底（桌面层）：不遮挡其他窗口；交互结束后失去焦点自动回到底层
            #[cfg(target_os = "windows")]
            {
                float_to_bottom(w);
                w.on_window_event(|event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        float_to_bottom_any();
                    }
                });
            }
        }
        Err(e) => core::log::error(&format!("[float] 浮窗创建失败: {e}")),
    }
    win.map(|_| ())
}

/// 把浮窗窗口 Z 序置底（HWND_BOTTOM）：普通窗口之下、桌面之上。
/// tao 的 HWND 为 isize，直接 extern 声明 Win32 API，零额外依赖。
#[cfg(target_os = "windows")]
mod win_bottom {
    use std::os::raw::c_void;

    const HWND_BOTTOM: isize = 1;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOACTIVATE: u32 = 0x0010;

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: *mut c_void,
            insert_after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    /// 记录浮窗 HWND，供失焦事件回调置底（回调拿不到窗口引用）。
    pub static FLOAT_HWND: std::sync::Mutex<Option<isize>> = std::sync::Mutex::new(None);

    pub fn set_bottom(hwnd: isize) {
        unsafe {
            let _ = SetWindowPos(
                hwnd as *mut c_void,
                HWND_BOTTOM,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    pub fn float_to_bottom(win: &tauri::WebviewWindow) {
        if let Ok(hwnd) = win.hwnd() {
            // tauri 的 HWND 是 windows crate 的元组结构体，.0 为原生指针
            let raw = hwnd.0 as isize;
            if let Ok(mut g) = FLOAT_HWND.lock() {
                *g = Some(raw);
            }
            set_bottom(raw);
        }
    }

    pub fn float_to_bottom_any() {
        let hwnd = {
            let g = FLOAT_HWND.lock().unwrap_or_else(|p| p.into_inner());
            *g
        };
        if let Some(hwnd) = hwnd {
            set_bottom(hwnd);
        }
    }
}

#[cfg(target_os = "windows")]
fn float_to_bottom(win: &tauri::WebviewWindow) {
    win_bottom::float_to_bottom(win);
}

#[cfg(target_os = "windows")]
fn float_to_bottom_any() {
    win_bottom::float_to_bottom_any();
}

#[cfg(not(target_os = "windows"))]
fn float_to_bottom(_win: &tauri::WebviewWindow) {}

#[cfg(not(target_os = "windows"))]
fn float_to_bottom_any() {}

/// 显示 / 隐藏浮窗（主窗口顶栏按钮调用）。返回操作后的可见状态。
#[tauri::command]
fn float_toggle(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri::Manager;
    let Some(win) = app.get_webview_window(FLOAT_WINDOW) else {
        return Err("浮窗未创建".to_string());
    };
    if win.is_visible().unwrap_or(true) {
        win.hide().map_err(|e| format!("隐藏浮窗失败: {e}"))?;
        write_float_visible(&app, false);
        Ok(false)
    } else {
        win.show().map_err(|e| format!("显示浮窗失败: {e}"))?;
        write_float_visible(&app, true);
        win.set_focus().ok();
        Ok(true)
    }
}

/// 锁定 / 解锁浮窗位置：锁定时禁止调整大小（拖拽由前端去掉 drag-region 禁用）。
#[tauri::command]
fn float_set_locked(app: tauri::AppHandle, locked: bool) -> Result<(), String> {
    use tauri::Manager;
    let Some(win) = app.get_webview_window(FLOAT_WINDOW) else {
        return Err("浮窗未创建".to_string());
    };
    win.set_resizable(!locked)
        .map_err(|e| format!("设置浮窗锁定失败: {e}"))
}
