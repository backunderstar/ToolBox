//! 笔记核心插件（cdylib，id: core-notes）。
//!
//! 命令（plugin_call("core-notes", ...)）：
//! - notes.list / notes.read / notes.write / notes.create / notes.delete / notes.rename
//!
//! 前端 api.ts 的 fs* 系列透明转发到这里（同一契约：vault 相对路径 + `/` 分隔）。

mod fs;

use serde_json::Value;
use tb_sdk::{tb_plugin, TbHostApi};
use std::ffi::c_void;

pub struct NotesState {
    vault: String,
}

fn state_from_cfg(cfg: &Value) -> Result<NotesState, String> {
    let vault = cfg
        .get("vault")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if vault.is_empty() {
        return Err("缺少 vault 配置".to_string());
    }
    Ok(NotesState { vault })
}

fn call(
    state: &mut NotesState,
    host: TbHostApi,
    ctx: *mut c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let vault = state.vault.clone();
    let s = |k: &str| {
        params
            .get(k)
            .and_then(|v| v.as_str())
            .map(String::from)
    };
    // 写操作后发 notes-changed（主窗 vault / 插件前端刷新文件列表，多窗口一致）
    let changed = |rel: &str| {
        tb_sdk::emit(host, ctx, "notes-changed", serde_json::json!({ "rel": rel }));
    };
    match method {
        "notes.list" => fs::list(&vault)
            .and_then(|v| serde_json::to_value(v).map_err(|e| format!("序列化失败: {e}"))),
        "notes.read" => {
            let rel = s("rel").ok_or("缺少 rel")?;
            fs::read(&vault, &rel).map(Value::String)
        }
        "notes.write" => {
            let rel = s("rel").ok_or("缺少 rel")?;
            let content = s("content").unwrap_or_default();
            fs::write(&vault, &rel, &content)?;
            changed(&rel);
            Ok(Value::Null)
        }
        "notes.create" => {
            let rel = s("rel").ok_or("缺少 rel")?;
            fs::create(&vault, &rel)?;
            changed(&rel);
            Ok(Value::Null)
        }
        "notes.delete" => {
            let rel = s("rel").ok_or("缺少 rel")?;
            fs::delete(&vault, &rel)?;
            changed(&rel);
            Ok(Value::Null)
        }
        "notes.rename" => {
            let from = s("from").ok_or("缺少 from")?;
            let to = s("to").ok_or("缺少 to")?;
            fs::rename(&vault, &from, &to)?;
            changed(&to);
            Ok(Value::Null)
        }
        _ => Err(format!("未知命令: {method}")),
    }
}

tb_plugin!(NotesState, state_from_cfg, call);
