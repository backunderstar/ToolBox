//! 搜索提供者：宿主搜索命令聚合各插件命中时，经 `search.provide` 调用本模块。
//!
//! 契约（宿主约定）：
//! - 入参 `{query, limit?}`
//! - 返回 `[{path, title, snippet}]`（path 为 vault 相对路径）
//! 任何插件（核心/外部）声明 manifest `searchProvider: true` 并实现该命令，
//! 注册（启用）后即自动进入全局搜索范围。

use serde_json::{json, Value};

use super::store::{list, RECORDS_DIR};

/// 搜索记录：标题 / 标签 / 正文包含关键词即命中。
pub fn provide(vault: &str, params: &Value) -> Result<Value, String> {
    let q = params
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let limit = params
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .min(100) as usize;
    if q.is_empty() {
        return Ok(json!([]));
    }
    let mut hits: Vec<Value> = Vec::new();
    for r in list(vault)? {
        if hits.len() >= limit {
            break;
        }
        let title_hit = r.title.to_lowercase().contains(&q);
        let tag_hit = r.tags.iter().any(|t| t.to_lowercase().contains(&q));
        let content_hit = r.content.to_lowercase().contains(&q);
        if title_hit || tag_hit || content_hit {
            let snippet = if title_hit {
                format!("记录：{}", r.title)
            } else {
                make_snippet(&r.content, &q)
            };
            hits.push(json!({
                "path": format!("{RECORDS_DIR}/{}.json", r.id),
                "title": r.title,
                "snippet": snippet,
            }));
        }
    }
    Ok(Value::Array(hits))
}

/// 按首次命中位置切 snippet（对齐宿主搜索的切法：前后各留上下文）。
fn make_snippet(content: &str, q: &str) -> String {
    let lower = content.to_lowercase();
    let Some(idx) = lower.find(q) else {
        return "…".to_string();
    };
    let start = idx.saturating_sub(20);
    let end = (idx + q.len() + 40).min(content.len());
    let s = content.floor_char_boundary(start.min(content.len()));
    let e = content.floor_char_boundary(end.min(content.len()));
    content
        .get(s..e)
        .unwrap_or("")
        .replace('\n', " ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::create;

    #[test]
    fn provider_hits_title_tags_content() {
        let v = std::env::temp_dir().join(format!("tb-provider-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&v);
        std::fs::create_dir_all(v.join(RECORDS_DIR)).unwrap();
        let vault = v.to_str().unwrap();
        create(
            vault,
            &json!({ "partial": { "title": "完成插件化设计", "tags": ["架构"], "content": "讨论 C ABI" } }),
        )
        .unwrap();
        create(
            vault,
            &json!({ "partial": { "title": "无关记录", "tags": [], "content": "买菜清单" } }),
        )
        .unwrap();

        // 标题命中
        let hits = provide(vault, &json!({ "query": "插件化" })).unwrap();
        assert_eq!(hits.as_array().unwrap().len(), 1);
        assert_eq!(hits[0]["title"], "完成插件化设计");
        // 正文命中
        let hits = provide(vault, &json!({ "query": "C ABI" })).unwrap();
        assert_eq!(hits.as_array().unwrap().len(), 1);
        assert!(hits[0]["snippet"].as_str().unwrap().contains("C ABI"));
        // 空查询
        assert!(provide(vault, &json!({ "query": "  " })).unwrap().as_array().unwrap().is_empty());
        // 未命中
        assert!(provide(vault, &json!({ "query": "不存在的词" })).unwrap().as_array().unwrap().is_empty());

        std::fs::remove_dir_all(&v).ok();
    }
}
