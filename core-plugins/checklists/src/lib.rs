//! 清单存储：vault/data/checklists/<id>.json。
//!
//! 由前端 src/core/checklists.tsx 数据层下沉：文件格式兼容
//! （Checklist/ChecklistItem 结构、camelCase 字段不变）；id 生成与
//! 同名冲突加序号逻辑移入插件（宿主进程内，独立于前端 UI 状态）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const CHECKLISTS_DIR: &str = "data/checklists";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    /// 关联笔记（vault 相对路径）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checklist {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub items: Vec<ChecklistItem>,
}

fn dir(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(CHECKLISTS_DIR)
}

/// 清单 id 安全校验：必须是文件名字符（无路径分隔符/`..`/控制字符）。
///
/// **为什么需要**：id 会拼进文件路径 `data/checklists/<id>.json`。若恶意构造
/// `id="../config"`，`path_for` 就会越出清单目录读写任意 JSON——此前只有
/// delete 校验了 id，get/save 没有（审计发现 S3 路径穿越）。统一收口到
/// check_id，get/save/delete 全部先校验。
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.chars().any(|c| c.is_control())
    {
        return Err(format!("非法清单 id: {id}"));
    }
    Ok(())
}

fn path_for(vault: &str, id: &str) -> PathBuf {
    dir(vault).join(format!("{id}.json"))
}

/// 原子写：临时文件 + rename。
fn save_file(path: &std::path::Path, list: &Checklist) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    let tmp = path.with_file_name(format!("{}.tmp", list.id));
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存失败: {e}"))
}

/// 读取全部清单（损坏文件跳过，不阻断其余）。
pub fn list(vault: &str) -> Result<Vec<Checklist>, String> {
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(dir(vault)) else {
        return Ok(out);
    };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.contains(".tmp") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        match serde_json::from_str::<Checklist>(&raw) {
            Ok(c) => out.push(c),
            Err(err) => {
                eprintln!("[checklists] 清单损坏已跳过 {}: {err}", e.path().display());
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// 按 id 读取（不存在 → None）。
pub fn get(vault: &str, id: &str) -> Result<Option<Checklist>, String> {
    check_id(id)?;
    let p = path_for(vault, id);
    if !p.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("清单数据非法: {e}"))
}

/// 标题 → id（slug）；冲突时追加 `-2`、`-3`…（不覆盖已有清单文件）。
pub fn create(vault: &str, title: &str) -> Result<Checklist, String> {
    let t = title.trim();
    if t.is_empty() {
        return Err("清单标题为空".to_string());
    }
    let now = tb_sdk::now_iso();
    let mut id = slugify(t, &now);
    let existing: Vec<String> = list(vault)?.into_iter().map(|c| c.id).collect();
    let mut n = 2;
    let base = id.clone();
    while existing.contains(&id) {
        id = format!("{base}-{n}");
        n += 1;
    }
    let list = Checklist {
        id,
        title: t.to_string(),
        created_at: now.clone(),
        updated_at: now,
        items: Vec::new(),
    };
    save_file(&path_for(vault, &list.id), &list)?;
    Ok(list)
}

/// 保存清单（updatedAt 统一刷新）；返回更新后的清单。
pub fn save(vault: &str, checklist: &Checklist) -> Result<Checklist, String> {
    check_id(&checklist.id)?;
    let mut list = checklist.clone();
    list.updated_at = tb_sdk::now_iso();
    save_file(&path_for(vault, &list.id), &list)?;
    Ok(list)
}

/// 删除清单（不存在视为成功——幂等）。
pub fn delete(vault: &str, id: &str) -> Result<Value, String> {
    check_id(id)?;
    let p = path_for(vault, id);
    match std::fs::remove_file(&p) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删除失败: {e}")),
    }
    Ok(json!({ "deleted": true }))
}

/// 标题 → 文件名 slug（与原前端一致：非字母数字连字符，≤40 字符）。
fn slugify(title: &str, now: &str) -> String {
    let mut s = String::new();
    let mut prev_sep = false;
    for ch in title.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            s.push(ch);
            prev_sep = false;
        } else if !prev_sep {
            s.push('-');
            prev_sep = true;
        }
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() || s.len() > 40 {
        let ms = now
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>();
        return format!("list-{ms}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb-chk-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn crud_roundtrip() {
        let v = tmp_vault("crud");
        let vault = v.to_str().unwrap();
        assert!(list(vault).unwrap().is_empty());

        let c = create(vault, "周计划").unwrap();
        assert_eq!(c.title, "周计划");
        assert!(!c.id.is_empty());
        assert!(path_for(vault, &c.id).exists());

        // 同名冲突 → 加序号
        let c2 = create(vault, "周计划").unwrap();
        assert_ne!(c.id, c2.id);

        // 保存更新
        let mut upd = c.clone();
        upd.items.push(ChecklistItem {
            id: "i1".into(),
            text: "写周报".into(),
            done: false,
            note: None,
        });
        let saved = save(vault, &upd).unwrap();
        assert_eq!(saved.items.len(), 1);
        assert!(saved.updated_at >= c.updated_at);
        assert_eq!(get(vault, &c.id).unwrap().unwrap().items.len(), 1);

        // 删除（幂等）
        delete(vault, &c.id).unwrap();
        delete(vault, &c.id).unwrap();
        assert!(get(vault, &c.id).unwrap().is_none());
        assert!(delete(vault, "../x").is_err());
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn corrupt_skipped() {
        let v = tmp_vault("corrupt");
        let vault = v.to_str().unwrap();
        std::fs::create_dir_all(dir(vault)).unwrap();
        std::fs::write(path_for(vault, "bad"), "{ 非法").unwrap();
        let c = create(vault, "正常").unwrap();
        let all = list(vault).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, c.id);
        std::fs::remove_dir_all(&v).ok();
    }

    /// S3 回归：get/save/delete 统一拒绝穿越 id（此前只有 delete 校验，
    /// get/save 可经 `../` 越出 data/checklists 目录任意读写 JSON）。
    #[test]
    fn rejects_traversal_ids() {
        let v = tmp_vault("traversal");
        let vault = v.to_str().unwrap();
        for bad in ["../evil", "..\\evil", "a/../../x", "/abs", "x\0y", ""] {
            assert!(get(vault, bad).is_err(), "get 应拒绝 {bad:?}");
            assert!(delete(vault, bad).is_err(), "delete 应拒绝 {bad:?}");
            let c = Checklist {
                id: bad.to_string(),
                title: "t".into(),
                created_at: "x".into(),
                updated_at: "x".into(),
                items: Vec::new(),
            };
            assert!(save(vault, &c).is_err(), "save 应拒绝 {bad:?}");
        }
        // 正常 id 不受影响
        let c = create(vault, "正常").unwrap();
        assert!(get(vault, &c.id).unwrap().is_some());
        std::fs::remove_dir_all(&v).ok();
    }
}

/* ---------------- 插件入口 ---------------- */

use tb_sdk::{emit, tb_plugin, TbHostApi};
use std::ffi::c_void;

pub struct ChecklistsState {
    vault: String,
}

fn state_from_cfg(cfg: &Value) -> Result<ChecklistsState, String> {
    let vault = cfg
        .get("vault")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if vault.is_empty() {
        return Err("缺少 vault 配置".to_string());
    }
    Ok(ChecklistsState { vault })
}

/// 命令分发。写操作成功后发 `chk-changed`（前端监听刷新）。
fn call(
    state: &mut ChecklistsState,
    host: TbHostApi,
    ctx: *mut c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let vault = state.vault.clone();
    let s = |k: &str| params.get(k).and_then(|v| v.as_str()).map(String::from);
    let to_val = |c: Checklist| -> Result<Value, String> {
        serde_json::to_value(c).map_err(|e| e.to_string())
    };
    match method {
        "chk.list" => {
            let all = list(&vault)?;
            serde_json::to_value(all).map_err(|e| e.to_string())
        }
        "chk.get" => {
            let id = s("id").ok_or("缺少 id")?;
            match get(&vault, &id)? {
                Some(c) => to_val(c),
                None => Ok(Value::Null),
            }
        }
        "chk.create" => {
            let title = s("title").ok_or("缺少 title")?;
            let out = to_val(create(&vault, &title)?)?;
            emit(host, ctx, "chk-changed", json!({ "action": "create" }));
            Ok(out)
        }
        "chk.save" => {
            let c: Checklist = serde_json::from_value(
                params.get("checklist").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| format!("清单数据非法: {e}"))?;
            let out = to_val(save(&vault, &c)?)?;
            emit(host, ctx, "chk-changed", json!({ "action": "save" }));
            Ok(out)
        }
        "chk.delete" => {
            let id = s("id").ok_or("缺少 id")?;
            let out = delete(&vault, &id)?;
            emit(host, ctx, "chk-changed", json!({ "action": "delete" }));
            Ok(out)
        }
        _ => Err(format!("未知命令: {method}")),
    }
}

tb_plugin!(ChecklistsState, state_from_cfg, call);
