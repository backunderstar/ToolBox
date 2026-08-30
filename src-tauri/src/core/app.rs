//! 应用外壳域：应用设置（app.json 通用键值）、系统托盘、窗口/浮窗生命周期、
//! 系统集成命令（资源管理器打开、标题栏近似色）。
//!
//! 结构整理（2026-09 拆分，原 lib.rs 957 行）：本模块收拢所有"窗口/托盘/设置"
//! 命令与回调，lib.rs 只留入口（run/setup/invoke_handler）与探针命令 ping。

use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// 退出标志：托盘"退出"置位后，窗口关闭事件不再拦截（放行真正退出）。
pub(crate) static EXITING: AtomicBool = AtomicBool::new(false);

/// 浮窗窗口标签。
pub(crate) const FLOAT_WINDOW: &str = "float";
/// 浮窗全局快捷键（任何窗口下显示/隐藏浮窗）。
pub(crate) const FLOAT_HOTKEY: &str = "Alt+Q";

/// 定位应用配置目录（%APPDATA%/com.toolbox.desktop，不存在则创建）。
pub(crate) fn app_config_dir(app: &tauri::AppHandle) -> Result<String, String> {
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

/// 读取整个应用设置 map（setup 恢复日志级别、设置页读取共用）。
pub(crate) fn load_app_settings(app: &tauri::AppHandle) -> serde_json::Map<String, serde_json::Value> {
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
pub(crate) fn close_behavior(app: &tauri::AppHandle) -> String {
    load_app_settings(app)
        .get("closeBehavior")
        .and_then(|v| v.as_str())
        .unwrap_or("tray")
        .to_string()
}

/// 是否启用系统托盘图标（app.json trayEnabled，默认 true）。
pub(crate) fn tray_enabled(app: &tauri::AppHandle) -> bool {
    load_app_settings(app)
        .get("trayEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// 原子写单个设置键（临时文件 + rename，与 plugins.json 同风格防损坏）。
pub(crate) fn write_app_setting(
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

/// 读取应用设置（整个 map，前端设置页用）。
#[tauri::command]
pub fn app_settings_get(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::Value::Object(load_app_settings(&app))
}

/// 写入单个设置键（原子写，与 plugins.json 同风格防损坏）。
#[tauri::command]
pub fn app_settings_set(
    app: tauri::AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    write_app_setting(&app, &key, value)
}

/// 设置托盘图标开关：运行时显示/隐藏托盘（设置页开关调用）。
#[tauri::command]
pub fn tray_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    write_app_setting(&app, "trayEnabled", json!(enabled))?;
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

/* ---- 系统集成命令 ---- */

/// 在系统文件管理器中打开指定路径（Windows：explorer.exe）。
/// 用于设置页"在资源管理器中打开工作区"。
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
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

/// 设置窗口标题栏近似色（主题联动，M5 增强）：
/// 前端在应用主题时把画布背景色（--bg 计算值）传过来，标题栏背景跟随主题
/// 大致色相变化（如暖色主题 → 米色标题栏、午夜蓝主题 → 深蓝标题栏）。
/// 实现：Windows 11 的 DwmSetWindowAttribute(DWMWA_CAPTION_COLOR)；不支持或
/// 调用失败时静默忽略（系统仍按亮/暗模式渲染标题栏，行为不劣化）。
/// color 传 null 恢复系统默认；非 Windows 平台为 no-op。
#[tauri::command]
pub fn set_window_caption_color(
    window: tauri::Window,
    color: Option<String>,
) -> Result<(), String> {
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

/* ---- 系统托盘 ---- */

/// 系统托盘：图标 + 菜单（显示主窗口 / 显示隐藏浮窗 / 插件动作段 / 退出）+ 单击切换主窗口。
/// 插件动作段由已启用插件 manifest `actions[].tray` 动态构建（rebuild_tray），
/// 插件启停变化经前端 `plugins-changed` 事件重建。
pub(crate) fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
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
pub(crate) fn rebuild_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    if !tray_enabled(app) {
        return Ok(());
    }
    use tauri::menu::{Menu, MenuItem};
    let show_main = MenuItem::with_id(app, "tray-show-main", "显示主窗口", true, None::<&str>)?;
    let toggle_float = MenuItem::with_id(app, "tray-toggle-float", "显示/隐藏浮窗", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 ToolBox", true, None::<&str>)?;
    // 插件段：已启用插件声明的 tray 动作（平铺，label = "插件名：动作名"）
    let mut plugin_items: Vec<tauri::menu::MenuItem<tauri::Wry>> = Vec::new();
    if let Ok(m) = app.state::<Mutex<crate::plugins::PluginManager>>().lock() {
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
            data: json!({ "action": action, "source": source }),
        },
    );
    let source = source.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        use crate::plugins::manifest::PluginRuntime;
        let Ok(Some(vault)) = crate::core::vault::read_vault_path(&app) else {
            return;
        };
        let _ = vault;
        let state = app.state::<Mutex<crate::plugins::PluginManager>>();
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
            json!({ "action": action, "source": source }),
        );
    });
}

/* ---- 主窗口 ---- */

/// 主窗口屏幕外自愈：若窗口位于明显屏幕外（显示器变更/window-state 残留），移到屏幕中心。
pub(crate) fn ensure_main_visible(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(pos) = main.outer_position() {
        if pos.x < -10_000 || pos.y < -10_000 || pos.x > 100_000 || pos.y > 100_000 {
            crate::core::log::warn(&format!(
                "[main] 窗口位于屏幕外 ({},{})，已移回中心",
                pos.x, pos.y
            ));
            main.center().ok();
            main.set_focus().ok();
        }
    }
}

/* ---- 桌面浮窗 ---- */

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
pub(crate) fn create_float_window(app: &tauri::AppHandle) -> tauri::Result<()> {
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
            crate::core::log::info(&format!("[float] 浮窗已创建 label={}", w.label()));
            // 透明窗口在 Windows 上可能保持隐藏（等待 WebView 初始化），
            // 按记忆的可见性显式显示/隐藏（上次隐藏则不打扰）
            let visible = read_float_visible(app);
            if visible {
                if let Err(e) = w.show() {
                    crate::core::log::error(&format!("[float] show 失败: {e}"));
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
        Err(e) => crate::core::log::error(&format!("[float] 浮窗创建失败: {e}")),
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
pub fn float_toggle(app: tauri::AppHandle) -> Result<bool, String> {
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
pub fn float_set_locked(app: tauri::AppHandle, locked: bool) -> Result<(), String> {
    let Some(win) = app.get_webview_window(FLOAT_WINDOW) else {
        return Err("浮窗未创建".to_string());
    };
    win.set_resizable(!locked)
        .map_err(|e| format!("设置浮窗锁定失败: {e}"))
}
