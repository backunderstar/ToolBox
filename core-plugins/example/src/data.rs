//! 数据层（教学点：以 vault 内普通文件为唯一真源 + 原子写 + 损坏隔离）。
//!
//! 与宿主/其他核心插件同一套文件约定：
//! - 数据文件 = vault 里的普通 JSON（`data/example/items.json`），用户可直接编辑/备份
//! - 写入用原子写（临时文件 + rename），崩溃/断电不会留下半截文件
//! - 文件损坏时**隔离改名保留现场**（`.corrupt-<时间戳>`），不覆盖用户数据
//! - 纯函数 + 单测：不依赖宿主与 FFI，`cargo test` 直接测

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 数据文件相对 vault 的路径（`/` 分隔）。
const ITEMS_REL: &str = "data/example/items.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExampleItem {
    pub id: String,
    pub text: String,
    pub done: bool,
    /// 本地时间（新建时刻）
    pub created_at: String,
}

fn items_path(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(ITEMS_REL)
}

/// 读取条目；文件不存在 → 空列表；文件**损坏** → 隔离改名并返回错误。
fn load_checked(path: &Path) -> Result<Vec<ExampleItem>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取失败: {e}")),
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    match serde_json::from_str::<Vec<ExampleItem>>(&raw) {
        Ok(v) => Ok(v),
        Err(e) => Err(quarantine_corrupt(path, e)),
    }
}

/// 把损坏文件改名为 `items.json.corrupt-<时间戳>` 保留现场（不覆盖用户数据）。
fn quarantine_corrupt(path: &Path, e: serde_json::Error) -> String {
    let ts = tb_sdk::now_iso().replace([':', ' '], "-");
    let bak = path.with_file_name(format!("items.json.corrupt-{ts}"));
    let _ = std::fs::rename(path, &bak);
    format!(
        "items.json 已损坏（{e}），原文件已隔离为 {}",
        bak.file_name().unwrap_or_default().to_string_lossy()
    )
}

/// 原子写：临时文件 + rename。
fn save(path: &Path, items: &[ExampleItem]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    let tmp = path.with_file_name("items.json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存失败: {e}"))
}

/// 生成唯一 id（时间戳纳秒，进程内足够）。
fn gen_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("e-{nanos}")
}

pub fn list(vault: &str) -> Result<Vec<ExampleItem>, String> {
    load_checked(&items_path(vault))
}

/// 添加条目（空文本拒绝）；返回更新后的完整列表。
pub fn add(vault: &str, text: &str) -> Result<Vec<ExampleItem>, String> {
    let path = items_path(vault);
    let mut items = load_checked(&path)?;
    let t = text.trim();
    if t.is_empty() {
        return Err("条目内容为空".to_string());
    }
    items.push(ExampleItem {
        id: gen_id(),
        text: t.to_string(),
        done: false,
        created_at: tb_sdk::now_iso(),
    });
    save(&path, &items)?;
    Ok(items)
}

pub fn toggle(vault: &str, id: &str) -> Result<Vec<ExampleItem>, String> {
    let path = items_path(vault);
    let mut items = load_checked(&path)?;
    if let Some(it) = items.iter_mut().find(|i| i.id == id) {
        it.done = !it.done;
    }
    save(&path, &items)?;
    Ok(items)
}

pub fn delete(vault: &str, id: &str) -> Result<Vec<ExampleItem>, String> {
    let path = items_path(vault);
    let items = load_checked(&path)?
        .into_iter()
        .filter(|i| i.id != id)
        .collect::<Vec<_>>();
    save(&path, &items)?;
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb-example-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 教学点：数据层是纯函数，cargo test 直接覆盖，无需宿主
    #[test]
    fn crud_roundtrip() {
        let v = tmp_vault("crud");
        let vault = v.to_str().unwrap();
        assert!(list(vault).unwrap().is_empty());
        let items = add(vault, "学核心插件").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "学核心插件");
        assert!(add(vault, "  ").is_err(), "空文本拒绝");
        let id = items[0].id.clone();
        let items = toggle(vault, &id).unwrap();
        assert!(items[0].done);
        let items = delete(vault, &id).unwrap();
        assert!(items.is_empty());
        std::fs::remove_dir_all(&v).ok();
    }

    /// 教学点：损坏文件隔离保留现场，不覆盖用户数据
    #[test]
    fn corrupt_file_quarantined() {
        let v = tmp_vault("corrupt");
        let vault = v.to_str().unwrap();
        let path = items_path(vault);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ 非法").unwrap();
        let err = list(vault).unwrap_err();
        assert!(err.contains("隔离"));
        assert!(!path.exists(), "损坏文件应被移走");
        assert!(list(vault).unwrap().is_empty());
        std::fs::remove_dir_all(&v).ok();
    }
}
