//! 待办存储：vault/data/todos/todos.json（浮窗数据层）。
//!
//! 由宿主 core/todos.rs 移植：文件为唯一真源，损坏文件隔离保留现场、
//! 原子写（临时文件 + rename）；变更后经 host 发 `todos-changed` 事件。

// tb_plugin! 展开的 FFI 入口（tb_create/tb_call）带裸指针参数，属 C ABI 语义；
// clippy 的 not_unsafe_ptr_arg_deref 对宏展开的 span 无法用局部 allow 压制
// （宏内/调用点 allow 均失效），文件级统一豁免。本文件除宏样板外无其他
// 裸指针公共 API（如有需单独复核）。
#![allow(clippy::not_unsafe_ptr_arg_deref)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

const TODOS_REL: &str = "data/todos/todos.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodosItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    /// 本地时间（新建时刻）
    pub created_at: String,
}

fn todos_path(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(TODOS_REL)
}

/// 读取待办；文件不存在 → 空列表；文件**损坏** → 隔离改名并返回错误。
fn load_checked(path: &Path) -> Result<Vec<TodosItem>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取待办失败: {e}")),
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Vec<TodosItem>>(&raw) {
        Ok(v) => Ok(v),
        Err(e) => Err(quarantine_corrupt(path, e)),
    }
}

/// 把损坏的 todos.json 改名为 `todos.json.corrupt-<时间戳>` 保留现场。
fn quarantine_corrupt(path: &Path, e: serde_json::Error) -> String {
    let ts = tb_sdk::now_iso().replace([':', ' '], "-");
    let bak = path.with_file_name(format!("todos.json.corrupt-{ts}"));
    let _ = std::fs::rename(path, &bak);
    format!(
        "todos.json 已损坏（{e}），原文件已隔离为 {}，待办未写入",
        bak.file_name().unwrap_or_default().to_string_lossy()
    )
}

/// 原子写：临时文件 + rename。
fn save(path: &Path, items: &[TodosItem]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    let tmp = path.with_file_name("todos.json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存失败: {e}"))
}

fn gen_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("t-{nanos}")
}

pub fn list(vault: &str) -> Result<Vec<TodosItem>, String> {
    load_checked(&todos_path(vault))
}

/// 添加待办（空文本拒绝）；返回更新后的完整列表。
pub fn add(vault: &str, text: &str) -> Result<Vec<TodosItem>, String> {
    let path = todos_path(vault);
    let mut items = load_checked(&path)?;
    let t = text.trim();
    if t.is_empty() {
        return Err("待办内容为空".to_string());
    }
    items.push(TodosItem {
        id: gen_id(),
        text: t.to_string(),
        done: false,
        created_at: tb_sdk::now_iso(),
    });
    save(&path, &items)?;
    Ok(items)
}

pub fn toggle(vault: &str, id: &str) -> Result<Vec<TodosItem>, String> {
    let path = todos_path(vault);
    let mut items = load_checked(&path)?;
    if let Some(it) = items.iter_mut().find(|i| i.id == id) {
        it.done = !it.done;
    }
    save(&path, &items)?;
    Ok(items)
}

pub fn delete(vault: &str, id: &str) -> Result<Vec<TodosItem>, String> {
    let path = todos_path(vault);
    let items = load_checked(&path)?
        .into_iter()
        .filter(|i| i.id != id)
        .collect::<Vec<_>>();
    save(&path, &items)?;
    Ok(items)
}

pub fn clear_done(vault: &str) -> Result<Vec<TodosItem>, String> {
    let path = todos_path(vault);
    let items = load_checked(&path)?
        .into_iter()
        .filter(|i| !i.done)
        .collect::<Vec<_>>();
    save(&path, &items)?;
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb-todos-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn crud_roundtrip() {
        let v = tmp_vault("crud");
        let vault = v.to_str().unwrap();
        assert!(list(vault).unwrap().is_empty());
        let items = add(vault, "写周报").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "写周报");
        assert!(add(vault, "  ").is_err(), "空文本拒绝");
        let id = items[0].id.clone();
        let items = toggle(vault, &id).unwrap();
        assert!(items[0].done);
        let items = delete(vault, &id).unwrap();
        assert!(items.is_empty());
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn corrupt_file_quarantined() {
        let v = tmp_vault("corrupt");
        let vault = v.to_str().unwrap();
        let path = todos_path(vault);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ 非法").unwrap();
        let err = list(vault).unwrap_err();
        assert!(err.contains("隔离"));
        assert!(!path.exists(), "损坏文件应被移走");
        assert!(list(vault).unwrap().is_empty());
        std::fs::remove_dir_all(&v).ok();
    }
}

/* ---------------- 插件入口 ---------------- */

use tb_sdk::{emit, tb_plugin, TbHostApi};
use std::ffi::c_void;

pub struct TodosState {
    vault: String,
}

fn state_from_cfg(cfg: &Value) -> Result<TodosState, String> {
    let vault = cfg
        .get("vault")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if vault.is_empty() {
        return Err("缺少 vault 配置".to_string());
    }
    Ok(TodosState { vault })
}

/// 命令分发。写操作成功后发 `todos-changed`（浮窗与主窗同步刷新）。
fn call(
    state: &mut TodosState,
    host: TbHostApi,
    ctx: *mut c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let vault = state.vault.clone();
    let s = |k: &str| params.get(k).and_then(|v| v.as_str()).map(String::from);
    let to_val = |items: Vec<TodosItem>| -> Result<Value, String> {
        serde_json::to_value(items).map_err(|e| e.to_string())
    };
    match method {
        "todos.list" => to_val(list(&vault)?),
        "todos.add" => {
            let text = s("text").ok_or("缺少 text")?;
            let out = to_val(add(&vault, &text)?)?;
            emit(host, ctx, "todos-changed", serde_json::json!({ "action": "add" }));
            Ok(out)
        }
        "todos.toggle" => {
            let id = s("id").ok_or("缺少 id")?;
            let out = to_val(toggle(&vault, &id)?)?;
            emit(host, ctx, "todos-changed", serde_json::json!({ "action": "toggle" }));
            Ok(out)
        }
        "todos.delete" => {
            let id = s("id").ok_or("缺少 id")?;
            let out = to_val(delete(&vault, &id)?)?;
            emit(host, ctx, "todos-changed", serde_json::json!({ "action": "delete" }));
            Ok(out)
        }
        "todos.clearDone" => {
            let out = to_val(clear_done(&vault)?)?;
            emit(host, ctx, "todos-changed", serde_json::json!({ "action": "clearDone" }));
            Ok(out)
        }
        _ => Err(format!("未知命令: {method}")),
    }
}

tb_plugin!(TodosState, state_from_cfg, call);
