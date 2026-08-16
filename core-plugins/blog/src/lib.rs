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
