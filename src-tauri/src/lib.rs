//! ToolBox 核心库：Tauri 主进程入口与命令注册。

mod core;
mod plugins;
mod rpc;

use core::{ai, backup, blog, history, notes, projects, todos, vault};
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
    eprintln!("[webview] {msg}");
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

/// 启动应用。
///
/// M1 已注册：`ping` + vault 工作区 + 笔记文件操作 + 文件夹选择对话框。
/// 后续里程碑把 `plugins`（插件管理器）、`rpc`（协议类型）接进来。
pub fn run() {
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
        // 注意：托盘/菜单是 Tauri 2 核心能力（tauri::tray / tauri::menu），无需额外插件
        // 插件命令签名要求 Mutex<PluginManager>（见 plugins/mod.rs 的 State 参数）
        .manage(Mutex::new(PluginManager::default()))
        .manage(blog::PreviewState::default())
        .on_window_event(|window, event| {
            // 关窗最小化到托盘：主窗口关闭请求 → 阻止并隐藏（托盘"退出"时放行）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && !EXITING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
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
            plugins::plugins_uninstall,
            plugins::plugins_read_file,
            plugins::plugins_invoke,
            ai::ai_config_get,
            ai::ai_config_set,
            ai::ai_config_set_key,
            ai::ai_config_clear_key,
            ai::ai_chat,
            ai::ai_chat_stream,
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
            history::history_init,
            history::history_status,
            history::history_commit,
            history::history_list,
            history::history_show,
            history::history_rollback,
            float_toggle,
            float_set_locked,
        ])
        .setup(|app| {
            // 后台自动备份线程（随应用常驻，读取配置按间隔执行）
            backup::spawn_auto(app.handle().clone());
            // 版本历史自动提交线程（编辑防抖 15s 后落盘为一次提交）
            history::spawn_auto_committer();
            // 插件事件桥：进程插件事件 → 前端 plugin-event 事件
            plugins::events::spawn_event_forwarder(app.handle().clone());
            // 系统托盘（关窗常驻后台）
            create_tray(app.handle())?;
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 浮窗窗口标签。
pub const FLOAT_WINDOW: &str = "float";

/// 主窗口屏幕外自愈：若窗口位于明显屏幕外（显示器变更/window-state 残留），移到屏幕中心。
fn ensure_main_visible(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(pos) = main.outer_position() {
        if pos.x < -10_000 || pos.y < -10_000 || pos.x > 100_000 || pos.y > 100_000 {
            eprintln!("[main] 窗口位于屏幕外 ({},{})，已移回中心", pos.x, pos.y);
            main.center().ok();
            main.set_focus().ok();
        }
    }
}

/// 系统托盘：图标 + 菜单（显示主窗口 / 显示隐藏浮窗 / 退出）+ 单击切换主窗口。
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
        .on_menu_event(|app, event| match event.id.as_ref() {
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
                // 退出前把待提交的编辑冲刷为版本快照（不丢最近 15s 内的修改）
                history::flush_pending();
                EXITING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
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
        let _ = std::fs::write(&p, format!("{{\"visible\": {visible}}}"));
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
            eprintln!("[float] 浮窗已创建 label={}", w.label());
            // 透明窗口在 Windows 上可能保持隐藏（等待 WebView 初始化），
            // 按记忆的可见性显式显示/隐藏（上次隐藏则不打扰）
            let visible = read_float_visible(app);
            if visible {
                if let Err(e) = w.show() {
                    eprintln!("[float] show 失败: {e}");
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
        Err(e) => eprintln!("[float] 浮窗创建失败: {e}"),
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
