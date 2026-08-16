//! 记录存储：vault/data/records/<id>.json。
//!
//! 由前端迁移而来（原 src/core/records.tsx 直接经通用 fs 命令读写 JSON），
//! 下沉为原生插件后：批量操作在宿主进程内完成，省去逐文件 IPC 往返。
//! 文件格式保持兼容（RecordData 结构、camelCase 字段不变）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 记录目录（vault 相对）
pub const RECORDS_DIR: &str = "data/records";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordData {
    pub id: String,
    pub title: String,
    /// YYYY-MM-DD
    pub date: String,
    pub tags: Vec<String>,
    pub content: String,
    pub created_at: String,
    pub updated_at: String,
}

fn records_dir(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(RECORDS_DIR)
}

/// 原子写：临时文件 + rename，避免写一半崩溃留下截断文件。
fn save_file(path: &Path, record: &RecordData) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    let tmp = path.with_file_name(format!("{}.tmp", record.id));
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("保存失败: {e}"))
}

/// 读取全部记录（损坏文件跳过，不阻断其余记录）。
pub fn list(vault: &str) -> Result<Vec<RecordData>, String> {
    let dir = records_dir(vault);
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(&dir) else {
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
        match serde_json::from_str::<RecordData>(&raw) {
            Ok(r) => out.push(r),
            Err(err) => {
                eprintln!("[records] 记录损坏已跳过 {}: {err}", e.path().display());
            }
        }
    }
    // 与前端一致：date 降序，同日 createdAt 新者在前
    out.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| b.created_at.cmp(&a.created_at)));
    Ok(out)
}

fn gen_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 36 进制 + 随机后缀（与原前端 r<ts36><rand36> 兼容）
    format!("r{:x}{:04x}", millis, rand_suffix())
}

fn rand_suffix() -> u16 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    (n & 0xFFFF) as u16
}

/// 新建记录；params.partial 可带初值。返回新记录。
pub fn create(vault: &str, params: &Value) -> Result<RecordData, String> {
    let partial = params.get("partial").cloned().unwrap_or(Value::Null);
    let now = tb_sdk::now_iso();
    let record = RecordData {
        id: gen_id(),
        title: partial
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "未命名记录".to_string()),
        date: partial
            .get("date")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| now[..10].to_string()),
        tags: partial
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        content: partial
            .get("content")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_default(),
        created_at: now.clone(),
        updated_at: now,
    };
    let path = records_dir(vault).join(format!("{}.json", record.id));
    save_file(&path, &record)?;
    Ok(record)
}

/// 保存记录（updatedAt 由插件统一刷新为当前时间）；返回更新后的记录。
pub fn save(vault: &str, params: &Value) -> Result<RecordData, String> {
    let mut record: RecordData = serde_json::from_value(
        params.get("record").cloned().unwrap_or(Value::Null),
    )
    .map_err(|e| format!("记录数据非法: {e}"))?;
    record.updated_at = tb_sdk::now_iso();
    let path = records_dir(vault).join(format!("{}.json", record.id));
    save_file(&path, &record)?;
    Ok(record)
}

/// 删除记录（不存在视为成功——幂等）。
pub fn delete(vault: &str, params: &Value) -> Result<Value, String> {
    let id = params
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("缺少 id")?;
    // 拒绝路径穿越：id 只允许出现在记录目录内
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(format!("非法记录 id: {id}"));
    }
    let path = records_dir(vault).join(format!("{id}.json"));
    match std::fs::remove_file(&path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("删除失败: {e}")),
    }
    Ok(json!({ "deleted": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("tb-records-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join(RECORDS_DIR)).unwrap();
        p
    }

    #[test]
    fn crud_roundtrip() {
        let v = tmp_vault("crud");
        let vault = v.to_str().unwrap();
        assert!(list(vault).unwrap().is_empty());

        // 新建（缺省初值）
        let r = create(vault, &json!({})).unwrap();
        assert_eq!(r.title, "未命名记录");
        assert_eq!(r.date.len(), 10);
        assert!(!r.id.is_empty());
        assert!(v.join(RECORDS_DIR).join(format!("{}.json", r.id)).exists());

        // 带初值
        let r2 = create(
            vault,
            &json!({ "partial": { "title": "  会议纪要  ", "tags": ["会议", "开发"], "content": "讨论 X" } }),
        )
        .unwrap();
        assert_eq!(r2.title, "会议纪要", "标题应 trim");
        assert_eq!(r2.tags.len(), 2);

        // 保存更新（updatedAt 刷新）
        let mut upd = r2.clone();
        upd.content = "新内容".into();
        let saved = save(vault, &json!({ "record": upd })).unwrap();
        assert_eq!(saved.content, "新内容");
        assert!(saved.updated_at >= r2.updated_at);
        let loaded = list(vault).unwrap();
        assert_eq!(loaded.len(), 2);

        // 删除（幂等）
        delete(vault, &json!({ "id": r2.id })).unwrap();
        delete(vault, &json!({ "id": r2.id })).unwrap(); // 已不存在 → 成功
        assert_eq!(list(vault).unwrap().len(), 1);
        // 路径穿越拒绝
        assert!(delete(vault, &json!({ "id": "../x" })).is_err());
        assert!(delete(vault, &json!({ "id": "a/b" })).is_err());

        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn sort_by_date_desc_then_created_desc() {
        let v = tmp_vault("sort");
        let vault = v.to_str().unwrap();
        let a = create(vault, &json!({ "partial": { "title": "旧", "date": "2026-01-01" } })).unwrap();
        let b = create(vault, &json!({ "partial": { "title": "新", "date": "2026-02-01" } })).unwrap();
        let c = create(vault, &json!({ "partial": { "title": "同日早", "date": "2026-02-01" } })).unwrap();
        let list = list(vault).unwrap();
        assert_eq!(list[0].id, b.id);
        assert_eq!(list[1].id, c.id);
        assert_eq!(list[2].id, a.id);
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn corrupt_record_skipped() {
        let v = tmp_vault("corrupt");
        let vault = v.to_str().unwrap();
        std::fs::write(v.join(RECORDS_DIR).join("bad.json"), "{ 非法").unwrap();
        let r = create(vault, &json!({ "partial": { "title": "正常" } })).unwrap();
        let list = list(vault).unwrap();
        assert_eq!(list.len(), 1, "损坏记录应跳过，正常记录不受影响");
        assert_eq!(list[0].id, r.id);
        std::fs::remove_dir_all(&v).ok();
    }
}
