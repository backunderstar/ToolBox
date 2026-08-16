//! 记录核心插件（cdylib，id: core-records）。
//!
//! 宿主经 C ABI 加载本 DLL；插件本身不接触 tauri 类型——命令分发纯函数，
//! 事件经 `TbHostApi::emit_event` 回灌宿主转发为 `plugin-event`。

mod provider;
mod store;

use serde_json::{json, Value};
use tb_sdk::{emit, tb_plugin, TbHostApi};
use std::ffi::c_void;

pub struct RecordsState {
    vault: String,
}

/// 宿主在加载时传入配置（当前包含工作区路径）。
fn state_from_cfg(cfg: &Value) -> Result<RecordsState, String> {
    let vault = cfg
        .get("vault")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if vault.is_empty() {
        return Err("缺少 vault 配置".to_string());
    }
    Ok(RecordsState { vault })
}

/// 命令分发。写操作成功后发 `records-changed` 事件（前端监听刷新）。
fn call(
    state: &mut RecordsState,
    host: TbHostApi,
    ctx: *mut c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "records.list" => store::list(&state.vault).map(|v| serde_json::to_value(v).unwrap_or(Value::Null)),
        "records.create" => {
            let r = store::create(&state.vault, &params)?;
            emit(host, ctx, "records-changed", json!({ "action": "create", "id": r.id }));
            serde_json::to_value(r).map_err(|e| e.to_string())
        }
        "records.save" => {
            let r = store::save(&state.vault, &params)?;
            emit(host, ctx, "records-changed", json!({ "action": "save", "id": r.id }));
            serde_json::to_value(r).map_err(|e| e.to_string())
        }
        "records.delete" => {
            let r = store::delete(&state.vault, &params)?;
            emit(host, ctx, "records-changed", json!({ "action": "delete" }));
            Ok(r)
        }
        "search.provide" => provider::provide(&state.vault, &params),
        _ => Err(format!("未知命令: {method}")),
    }
}

tb_plugin!(RecordsState, state_from_cfg, call);
