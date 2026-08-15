//! 快速待办（浮窗清单）：vault/data/todos/todos.json。
//!
//! - 独立于清单（checklists）：浮窗追求极简，只存 {text, done}
//! - 文件为唯一真源；每次变更后向所有窗口广播 `todos-changed` 事件
//! - 命令内部通过应用配置读取当前工作区（浮窗与主窗口共用）

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const TODOS_REL: &str = "data/todos/todos.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodosItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    /// ISO 8601 本地时间（新建时刻）
    pub created_at: String,
}

fn todos_path(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(TODOS_REL)
}

fn current_vault(app: &AppHandle) -> Result<String, String> {
    crate::core::vault::read_vault_path(app)?
        .ok_or_else(|| "请先选择工作区".to_string())
}

fn load(path: &Path) -> Vec<TodosItem> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<TodosItem>>(&raw).unwrap_or_default()
}

fn save(path: &Path, items: &[TodosItem]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| format!("保存失败: {e}"))
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 简单本地时间格式 YYYY-MM-DD HH:MM:SS（不引 chrono 依赖）
    let secs = now / 1000;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 1970-01-01 起的天数 → 年月日（民用日历算法）
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

fn gen_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("t-{nanos}")
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("todos-changed", ());
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
pub fn todos_list(app: AppHandle) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    Ok(load(&todos_path(&vault)))
}

/// 添加待办（空文本拒绝）；返回更新后的完整列表。
#[tauri::command]
pub fn todos_add(app: AppHandle, text: String) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    let path = todos_path(&vault);
    let mut items = load(&path);
    let t = text.trim();
    if t.is_empty() {
        return Err("待办内容为空".to_string());
    }
    items.push(TodosItem {
        id: gen_id(),
        text: t.to_string(),
        done: false,
        created_at: now_iso(),
    });
    save(&path, &items)?;
    emit_changed(&app);
    Ok(items)
}

#[tauri::command]
pub fn todos_toggle(app: AppHandle, id: String) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    let path = todos_path(&vault);
    let mut items = load(&path);
    if let Some(it) = items.iter_mut().find(|i| i.id == id) {
        it.done = !it.done;
    }
    save(&path, &items)?;
    emit_changed(&app);
    Ok(items)
}

#[tauri::command]
pub fn todos_delete(app: AppHandle, id: String) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    let path = todos_path(&vault);
    let items = load(&path).into_iter().filter(|i| i.id != id).collect::<Vec<_>>();
    save(&path, &items)?;
    emit_changed(&app);
    Ok(items)
}

#[tauri::command]
pub fn todos_clear_done(app: AppHandle) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    let path = todos_path(&vault);
    let items = load(&path).into_iter().filter(|i| !i.done).collect::<Vec<_>>();
    save(&path, &items)?;
    emit_changed(&app);
    Ok(items)
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("toolbox-todos-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn crud_roundtrip() {
        let v = tmp_dir("crud");
        let path = todos_path(v.to_str().unwrap());
        // 空文件 → 空列表
        assert!(load(&path).is_empty());

        // 添加
        let mut items = load(&path);
        items.push(TodosItem {
            id: "a".into(),
            text: "写周报".into(),
            done: false,
            created_at: "2026-08-15 10:00:00".into(),
        });
        save(&path, &items).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].text, "写周报");
        assert!(!loaded[0].done);

        // 切换完成态
        let mut items = loaded;
        items[0].done = true;
        save(&path, &items).unwrap();
        assert!(load(&path)[0].done);

        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn iso_time_format() {
        let s = now_iso();
        assert!(s.len() >= 19, "应为 YYYY-MM-DD HH:MM:SS: {s}");
        let (y, m, d) = civil_from_days(0); // 1970-01-01
        assert_eq!((y, m, d), (1970, 1, 1));
        let (y2, m2, d2) = civil_from_days(20_000); // 1970 起第 20000 天
        assert_eq!(y2, 2024);
        assert_eq!((m2, d2), (10, 4));
    }
}
