//! 快速待办（浮窗清单）：vault/data/todos/todos.json。
//!
//! - 独立于清单（checklists）：浮窗追求极简，只存 {text, done}
//! - 文件为唯一真源；每次变更后向所有窗口广播 `todos-changed` 事件
//! - 命令内部通过应用配置读取当前工作区（浮窗与主窗口共用）
//!
//! 可靠性（体检修复）：
//! - 文件损坏不再静默 `unwrap_or_default`（会把空列表写回、清空全部待办）：
//!   检测到解析失败时把损坏文件**隔离改名**保留现场，并拒绝后续写回
//! - 写入改"临时文件 + rename"原子替换，避免崩溃/断电截断 + 备份拷到半截
//! - `created_at` 用系统本地时间（Windows GetLocalTime），不再按 UTC epoch 直算

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
    /// 本地时间（新建时刻）
    pub created_at: String,
}

fn todos_path(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(TODOS_REL)
}

fn current_vault(app: &AppHandle) -> Result<String, String> {
    crate::core::vault::read_vault_path(app)?
        .ok_or_else(|| "请先选择工作区".to_string())
}

/// 读取待办；文件不存在 → 空列表；文件**损坏** → 隔离改名并返回错误。
/// 所有写路径都先过这里：损坏时直接失败，绝不把空列表写回覆盖真数据。
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

/// 把损坏的 todos.json 改名为 `todos.json.corrupt-<时间戳>` 保留现场，
/// 返回给用户的错误信息（用户可手动恢复，后续写操作不再覆盖它）。
fn quarantine_corrupt(path: &Path, e: serde_json::Error) -> String {
    let ts = now_iso().replace([':', ' '], "-");
    let bak = path.with_file_name(format!("todos.json.corrupt-{ts}"));
    let _ = std::fs::rename(path, &bak);
    format!(
        "todos.json 已损坏（{e}），原文件已隔离为 {}，待办未写入",
        bak.file_name().unwrap_or_default().to_string_lossy()
    )
}

/// 原子写：临时文件 + rename，避免写一半崩溃留下截断文件。
fn save(path: &Path, items: &[TodosItem]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    let tmp = path.with_file_name("todos.json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存失败: {e}"))
}

fn now_iso() -> String {
    // Windows 直接取系统本地时间（GetLocalTime），正确反映东八区等时区
    #[cfg(windows)]
    {
        return win_local_now_iso();
    }
    // 其他平台：UTC 近似（不引 chrono；后续可接 libc localtime_r）
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
    load_checked(&todos_path(&vault))
}

/// 添加待办（空文本拒绝）；返回更新后的完整列表。
#[tauri::command]
pub fn todos_add(app: AppHandle, text: String) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    let path = todos_path(&vault);
    let mut items = load_checked(&path)?;
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
    crate::core::history::mark_dirty(&vault);
    Ok(items)
}

#[tauri::command]
pub fn todos_toggle(app: AppHandle, id: String) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    let path = todos_path(&vault);
    let mut items = load_checked(&path)?;
    if let Some(it) = items.iter_mut().find(|i| i.id == id) {
        it.done = !it.done;
    }
    save(&path, &items)?;
    emit_changed(&app);
    crate::core::history::mark_dirty(&vault);
    Ok(items)
}

#[tauri::command]
pub fn todos_delete(app: AppHandle, id: String) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    let path = todos_path(&vault);
    let items = load_checked(&path)?
        .into_iter()
        .filter(|i| i.id != id)
        .collect::<Vec<_>>();
    save(&path, &items)?;
    emit_changed(&app);
    crate::core::history::mark_dirty(&vault);
    Ok(items)
}

#[tauri::command]
pub fn todos_clear_done(app: AppHandle) -> Result<Vec<TodosItem>, String> {
    let vault = current_vault(&app)?;
    let path = todos_path(&vault);
    let items = load_checked(&path)?
        .into_iter()
        .filter(|i| !i.done)
        .collect::<Vec<_>>();
    save(&path, &items)?;
    emit_changed(&app);
    crate::core::history::mark_dirty(&vault);
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
        assert!(load_checked(&path).unwrap().is_empty());

        // 添加
        let mut items = load_checked(&path).unwrap();
        items.push(TodosItem {
            id: "a".into(),
            text: "写周报".into(),
            done: false,
            created_at: "2026-08-15 10:00:00".into(),
        });
        save(&path, &items).unwrap();
        let loaded = load_checked(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].text, "写周报");
        assert!(!loaded[0].done);

        // 切换完成态
        let mut items = loaded;
        items[0].done = true;
        save(&path, &items).unwrap();
        assert!(load_checked(&path).unwrap()[0].done);

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

    /// 损坏文件：解析失败 → 报错并隔离改名，且后续写路径不被空列表覆盖。
    #[test]
    fn corrupted_file_quarantined() {
        let v = tmp_dir("corrupt");
        let path = todos_path(v.to_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ 这不是合法 JSON").unwrap();

        let err = load_checked(&path).unwrap_err();
        assert!(err.contains("隔离"), "错误信息应说明隔离: {err}");
        // 原文件已被改名保留，不再占用 todos.json 路径
        assert!(!path.exists(), "损坏文件应被移走");
        let renamed: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(renamed.len(), 1, "应有隔离文件保留现场");
        // 再次读取 → 空列表（不会写回覆盖）
        assert!(load_checked(&path).unwrap().is_empty());

        std::fs::remove_dir_all(&v).ok();
    }
}
