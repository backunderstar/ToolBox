//! ToolBox 核心插件 SDK：宿主 ↔ 插件 的 C ABI 契约与开发样板。
//!
//! 核心插件 = 编译为 cdylib（Windows .dll）的独立 Rust crate，宿主用
//! libloading 加载，经 5 个 `extern "C"` 导出符号调用：
//!
//! - `tb_abi_version()`    ABI 契约版本（不匹配拒绝加载）
//! - `tb_create(cfg, host)` 创建插件实例（cfg = 配置 JSON，host = 宿主服务表）
//! - `tb_call(h, method, params)` 调用命令（返回结果 JSON，宿主负责释放）
//! - `tb_free_string(s)`   释放 tb_call 返回的字符串
//! - `tb_destroy(h)`       销毁插件实例
//!
//! 开发一个插件只需写三样：state 类型、state 构造函数、命令分发函数，
//! 然后 `tb_plugin!(...)` 生成全部 FFI 样板（含 panic 隔离）。

use serde_json::Value;
use std::ffi::{c_char, c_void, CStr, CString};

/// C ABI 契约版本。宿主加载插件时校验一致；不兼容的 DLL 拒绝加载。
pub const ABI_VERSION: u32 = 2;

/// 宿主回灌给插件的服务表（函数指针，`tb_create` 时传入）。
/// 回调均为 `unsafe extern "C"`；回调的 `ctx` 参数 = 本表的 `ctx` 字段
/// （宿主分配的上下文指针，当前 = 插件 id），插件原样透传。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct TbHostApi {
    pub abi_version: u32,
    /// 宿主上下文指针（回调 ctx 参数，插件不得解引用/释放）
    pub ctx: *mut c_void,
    /// 事件：插件 → 前端（宿主转发为 `plugin-event`）。返回 0 成功。
    pub emit_event: Option<
        unsafe extern "C" fn(ctx: *mut c_void, event: *const c_char, data: *const c_char) -> i32,
    >,
    /// 日志：level 0=info 1=warn 2=error
    pub log: Option<unsafe extern "C" fn(ctx: *mut c_void, level: i32, msg: *const c_char)>,
}

impl TbHostApi {
    /// 从原始指针读取（null 安全：测试或无宿主时用空表）。
    pub unsafe fn from_ptr(p: *const TbHostApi) -> Self {
        if p.is_null() {
            Self {
                abi_version: ABI_VERSION,
                ctx: std::ptr::null_mut(),
                emit_event: None,
                log: None,
            }
        } else {
            unsafe { *p }
        }
    }
}

/// 插件实例：`tb_create` 创建并装箱，`tb_call` / `tb_destroy` 使用。
pub struct PluginBox<T> {
    pub state: T,
    pub host: TbHostApi,
    /// 宿主上下文指针（回调的 ctx 参数，原样透传）
    pub host_ctx: *mut c_void,
}

/// 安全读取 C 字符串（null 返回 None）。
pub unsafe fn read_str<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(p).to_str().ok() }
}

/// 解析入参 JSON（失败 → 错误，由调用方决定兜底）。
pub fn parse_params(s: &str) -> Result<Value, String> {
    serde_json::from_str(s).map_err(|e| format!("参数解析失败: {e}"))
}

/// 统一调用结果编码：`{"ok": true, "result": ...}` 或 `{"ok": false, "error": ...}`。
pub fn encode_result(r: Result<Value, String>) -> String {
    let v = match r {
        Ok(v) => serde_json::json!({ "ok": true, "result": v }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    };
    v.to_string()
}

/// 解析统一结果 JSON（宿主侧）：返回 Result<Value(原始 result), String(error)>。
pub fn decode_result(raw: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("插件返回非法 JSON: {e}"))?;
    if v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false) {
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("插件调用失败")
            .to_string())
    }
}

/// 事件发送（经宿主回调；无宿主/回调时静默丢弃）。
pub fn emit(host: TbHostApi, ctx: *mut c_void, event: &str, data: Value) {
    if let Some(f) = host.emit_event {
        let ev = CString::new(event);
        let da = CString::new(data.to_string());
        if let (Ok(ev), Ok(da)) = (ev, da) {
            unsafe { f(ctx, ev.as_ptr(), da.as_ptr()) };
        }
    }
}

/// 日志（经宿主回调；无宿主时打到 stderr）。
pub fn log(host: TbHostApi, ctx: *mut c_void, level: i32, msg: &str) {
    if let Some(f) = host.log {
        if let Ok(m) = CString::new(msg) {
            unsafe { f(ctx, level, m.as_ptr()) };
            return;
        }
    }
    eprintln!("[plugin] {msg}");
}

/// 本地时间 `YYYY-MM-DD HH:MM:SS`（Windows GetLocalTime；其他平台民用日历 UTC 近似）。
pub fn now_iso() -> String {
    #[cfg(windows)]
    {
        return win_local_now_iso();
    }
    #[allow(unreachable_code)]
    utc_now_iso()
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetLocalTime(lpSystemTime: *mut SYSTEMTIME);
}

#[cfg(windows)]
#[repr(C)]
#[allow(non_snake_case)] // Win32 SYSTEMTIME 字段名（wYear 等）保持原样
struct SYSTEMTIME {
    wYear: u16,
    wMonth: u16,
    wDayOfWeek: u16,
    wDay: u16,
    wHour: u16,
    wMinute: u16,
    wSecond: u16,
    wMilliseconds: u16,
}

#[cfg(windows)]
fn win_local_now_iso() -> String {
    let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut st) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
    )
}

/// UTC 版本（非 Windows 平台兜底）。
fn utc_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let secs = now / 1000;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days as i64);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

/// days 自 1970-01-01 起的天数 → (年, 月, 日)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 生成插件样板：`tb_plugin!(State, state_from_cfg, call)`。
///
/// - `state_from_cfg: fn(&Value) -> Result<State, String>` — 由配置构造实例
/// - `call: fn(&mut State, TbHostApi, *mut c_void, &str, Value) -> Result<Value, String>`
///   — 命令分发（method + params → result）；写操作后可用 `tb_sdk::emit` 发事件
///
/// 宏生成 5 个 `#[no_mangle] extern "C"` 导出符号，`tb_call` 内部
/// `catch_unwind` 隔离插件 panic（返回错误 JSON，不崩宿主）。
#[macro_export]
macro_rules! tb_plugin {
    ($state:ty, $state_from_cfg:path, $call:path) => {
        #[no_mangle]
        pub extern "C" fn tb_abi_version() -> u32 {
            $crate::ABI_VERSION
        }

        #[no_mangle]
        pub extern "C" fn tb_create(
            config_json: *const std::ffi::c_char,
            host: *const $crate::TbHostApi,
        ) -> *mut std::ffi::c_void {
            let host = unsafe { $crate::TbHostApi::from_ptr(host) };
            let cfg = unsafe { $crate::read_str(config_json) }
                .and_then(|s| $crate::parse_params(s).ok())
                .unwrap_or(serde_json::Value::Null);
            let state = match $state_from_cfg(&cfg) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[plugin] 初始化失败: {e}");
                    return std::ptr::null_mut();
                }
            };
            let b = $crate::PluginBox {
                state,
                host,
                host_ctx: host.ctx,
            };
            Box::into_raw(Box::new(b)) as *mut std::ffi::c_void
        }

        #[no_mangle]
        pub extern "C" fn tb_call(
            handle: *mut std::ffi::c_void,
            method: *const std::ffi::c_char,
            params: *const std::ffi::c_char,
        ) -> *mut std::ffi::c_char {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let b = unsafe { &mut *(handle as *mut $crate::PluginBox<$state>) };
                let host = b.host; // Copy：避免 &mut state 与 &box 借用冲突
                let ctx = b.host_ctx;
                let m = unsafe { $crate::read_str(method) }
                    .unwrap_or("")
                    .to_string();
                let p = unsafe { $crate::read_str(params) }
                    .and_then(|s| $crate::parse_params(s).ok())
                    .unwrap_or(serde_json::Value::Null);
                $call(&mut b.state, host, ctx, &m, p)
            }));
            let out = match result {
                Ok(r) => $crate::encode_result(r),
                Err(_) => $crate::encode_result(Err("插件 panic（已隔离）".to_string())),
            };
            match std::ffi::CString::new(out) {
                Ok(c) => c.into_raw(),
                Err(_) => std::ptr::null_mut(),
            }
        }

        #[no_mangle]
        pub extern "C" fn tb_free_string(s: *mut std::ffi::c_char) {
            if !s.is_null() {
                unsafe {
                    drop(std::ffi::CString::from_raw(s));
                }
            }
        }

        #[no_mangle]
        pub extern "C" fn tb_destroy(handle: *mut std::ffi::c_void) {
            if !handle.is_null() {
                unsafe {
                    drop(Box::from_raw(handle as *mut $crate::PluginBox<$state>));
                }
            }
        }
    };
}
