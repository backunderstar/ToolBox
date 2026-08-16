//! 博客核心插件（cdylib，id: core-blog）。
//!
//! 命令（plugin_call("core-blog", ...)）：
//! - blog.list / blog.generate / blog.previewStart / blog.previewStop / blog.openFolder

mod core;

use serde_json::Value;
use tb_sdk::{tb_plugin, TbHostApi};
use std::ffi::c_void;

pub struct BlogState {
    vault: String,
}

impl Drop for BlogState {
    fn drop(&mut self) {
        // 安全（S4）：宿主禁用/重载插件会 FreeLibrary 卸载 DLL——若预览线程
        // 还活着并在执行已卸载的代码，宿主进程直接崩溃。这里在实例销毁前
        // 停止预览服务器并 join 线程，保证卸载时无残留线程。
        let _ = core::preview_stop();
    }
}

fn state_from_cfg(cfg: &Value) -> Result<BlogState, String> {
    let vault = cfg
        .get("vault")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if vault.is_empty() {
        return Err("缺少 vault 配置".to_string());
    }
    Ok(BlogState { vault })
}

fn call(
    state: &mut BlogState,
    _host: TbHostApi,
    _ctx: *mut c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let vault = state.vault.clone();
    let s = |k: &str| params.get(k).and_then(|v| v.as_str()).map(String::from);
    match method {
        "blog.list" => {
            let out = core::list(&vault);
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "blog.generate" => {
            let title = s("siteTitle").unwrap_or_default();
            let out = core::generate(&vault, &title)?;
            serde_json::to_value(out).map_err(|e| e.to_string())
        }
        "blog.previewStart" => core::preview_start(&vault).map(Value::String),
        "blog.previewStop" => {
            core::preview_stop()?;
            Ok(Value::Null)
        }
        "blog.openFolder" => {
            core::open_folder(&vault)?;
            Ok(Value::Null)
        }
        _ => Err(format!("未知命令: {method}")),
    }
}

tb_plugin!(BlogState, state_from_cfg, call);
