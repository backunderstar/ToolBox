//! 原生插件加载器：核心插件（cdylib DLL）经 libloading + C ABI 加载。
//!
//! 性能定位：FFI 函数调用 + JSON 序列化（微秒级），介于"编译进宿主"与
//! "进程插件（毫秒级 IPC）"之间，是外部可替换实现里最快的通道。
//!
//! 安全模型：核心插件是**信任代码**（随应用分发，`catch_unwind` 隔离 panic），
//! 与 webview/process 外部插件的权限门控不同——此处不做沙箱。

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::sync::OnceLock;

use serde_json::Value;
use tauri::AppHandle;

use crate::plugins::events::PluginEvent;

/// 事件回调需要 AppHandle：setup 时初始化（进程级，只设一次）。
static HOST_APP: OnceLock<AppHandle> = OnceLock::new();

/// 注册宿主 AppHandle（事件转发用）。
pub fn init_host_app(app: AppHandle) {
    let _ = HOST_APP.set(app);
}

/// 事件回调的 ctx：指向插件 id（每个 NativePlugin 一份）。
pub struct HostCtx(String);

/// 事件回调：插件 → 前端 `plugin-event`（复用事件桥载荷，PluginsView 日志照常）。
unsafe extern "C" fn host_emit_event(
    ctx: *mut c_void,
    event: *const c_char,
    data: *const c_char,
) -> i32 {
    let Some(app) = HOST_APP.get() else {
        return -1;
    };
    let plugin_id = unsafe { &*(ctx as *const HostCtx) }.0.clone();
    let Some(event) = unsafe { tb_sdk::read_str(event) }.map(String::from) else {
        return -1;
    };
    let data: Value = unsafe { tb_sdk::read_str(data) }
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null);
    use tauri::Emitter;
    let _ = app.emit("plugin-event", PluginEvent { plugin_id, event, data });
    0
}

/// 日志回调：打到宿主终端（`pnpm tauri dev` 可见）。
unsafe extern "C" fn host_log(_ctx: *mut c_void, level: i32, msg: *const c_char) {
    let msg = unsafe { tb_sdk::read_str(msg) }.unwrap_or("");
    match level {
        0 => eprintln!("[plugin:log] {msg}"),
        1 => eprintln!("[plugin:warn] {msg}"),
        _ => eprintln!("[plugin:error] {msg}"),
    }
}

/// 打开路径回调：系统默认应用 / 资源管理器（tauri-plugin-opener）。
unsafe extern "C" fn host_open_path(_ctx: *mut c_void, path: *const c_char) -> i32 {
    let raw = unsafe { tb_sdk::read_str(path) };
    let Some(path) = raw else {
        return -1;
    };
    match tauri_plugin_opener::open_path(path, None::<&str>) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

/* ---------------- C ABI 函数指针类型 ---------------- */

type FnAbi = extern "C" fn() -> u32;
type FnCreate = extern "C" fn(*const c_char, *const tb_sdk::TbHostApi) -> *mut c_void;
type FnCall = extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_char;
type FnFree = extern "C" fn(*mut c_char);
type FnDestroy = extern "C" fn(*mut c_void);

/// 已加载的原生插件实例（持有 DLL 句柄，Drop 时销毁插件并释放库）。
pub struct NativePlugin {
    _lib: libloading::Library,
    handle: *mut c_void,
    ctx: *mut c_void,
    call_fn: FnCall,
    free_fn: FnFree,
    destroy_fn: FnDestroy,
}

// PluginManager 在 Mutex 内使用（&mut 访问）：Send 足够。
// 调用经 libloading 函数指针，DLL 句柄由 _lib 保活；本类型 Drop 保证顺序。
unsafe impl Send for NativePlugin {}

impl NativePlugin {
    /// 加载 DLL + 创建插件实例。config_json 原样传给插件（当前含 vault 路径）。
    pub fn load(dll: &Path, plugin_id: &str, config_json: &str) -> Result<Self, String> {
        unsafe {
            let lib = libloading::Library::new(dll)
                .map_err(|e| format!("加载 DLL 失败（{}）: {e}", dll.display()))?;
            // 块内提取函数指针（Symbol 借用 lib）并创建实例；
            // 块结束释放借用后才 move lib 进结构体
            let (call_fn, free_fn, destroy_fn, handle, ctx) = {
                let abi: libloading::Symbol<FnAbi> = lib
                    .get(b"tb_abi_version\0")
                    .map_err(|e| format!("DLL 缺少 tb_abi_version（不是核心插件?）: {e}"))?;
                let abi = abi();
                if abi != tb_sdk::ABI_VERSION {
                    return Err(format!(
                        "ABI 版本不兼容（插件 {abi}，宿主 {}）",
                        tb_sdk::ABI_VERSION
                    ));
                }
                let create: libloading::Symbol<FnCreate> = lib
                    .get(b"tb_create\0")
                    .map_err(|e| format!("DLL 缺少 tb_create: {e}"))?;
                let call: libloading::Symbol<FnCall> = lib
                    .get(b"tb_call\0")
                    .map_err(|e| format!("DLL 缺少 tb_call: {e}"))?;
                let free: libloading::Symbol<FnFree> = lib
                    .get(b"tb_free_string\0")
                    .map_err(|e| format!("DLL 缺少 tb_free_string: {e}"))?;
                let destroy: libloading::Symbol<FnDestroy> = lib
                    .get(b"tb_destroy\0")
                    .map_err(|e| format!("DLL 缺少 tb_destroy: {e}"))?;

                let ctx = Box::into_raw(Box::new(HostCtx(plugin_id.to_string()))) as *mut c_void;
                let host = tb_sdk::TbHostApi {
                    abi_version: tb_sdk::ABI_VERSION,
                    ctx,
                    emit_event: Some(host_emit_event),
                    log: Some(host_log),
                    open_path: Some(host_open_path),
                };
                let cfg = CString::new(config_json).map_err(|e| e.to_string())?;
                let handle = create(cfg.as_ptr(), &host);
                if handle.is_null() {
                    drop(Box::from_raw(ctx as *mut HostCtx));
                    return Err("插件初始化失败（tb_create 返回空）".to_string());
                }
                (*call, *free, *destroy, handle, ctx)
            };
            Ok(NativePlugin {
                _lib: lib,
                handle,
                ctx,
                call_fn,
                free_fn,
                destroy_fn,
            })
        }
    }

    /// 调用插件命令（method + params → result；错误已解码）。
    pub fn call(&self, method: &str, params: &Value) -> Result<Value, String> {
        let m = CString::new(method).map_err(|e| e.to_string())?;
        let p = CString::new(params.to_string()).map_err(|e| e.to_string())?;
        let out = (self.call_fn)(self.handle, m.as_ptr(), p.as_ptr());
        if out.is_null() {
            return Err("插件返回空结果（可能已 panic）".to_string());
        }
        let raw = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
        (self.free_fn)(out);
        tb_sdk::decode_result(&raw)
    }
}

impl Drop for NativePlugin {
    fn drop(&mut self) {
        unsafe {
            (self.destroy_fn)(self.handle);
            drop(Box::from_raw(self.ctx as *mut HostCtx));
        }
    }
}
