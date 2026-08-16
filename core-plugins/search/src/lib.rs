//! 全文搜索：SQLite FTS5（trigram 分词器）索引。
//!
//! 由宿主 core/search.rs 移植（自包含 collect_md；笔记目录 vault/notes）。
//! 索引文件 `vault/.toolbox/search-fts.sqlite`；笔记是真源，索引可随时重建。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 笔记目录（vault/notes/）
const NOTES_DIR: &str = "notes";
const IGNORED_DIRS: &[&str] = &[".git", ".toolbox", "node_modules", "target", "site"];

/// 索引数据库文件名（位于 vault/.toolbox/ 下）。
const INDEX_FILE: &str = "search-fts.sqlite";
/// 索引时每文件最多读取的字节数（超大文件截断索引，避免内存暴涨）
const INDEX_READ_LIMIT: u64 = 2 * 1024 * 1024;
/// snippet / 短词线性扫描每文件最多读取的字节数
const SEARCH_READ_LIMIT: u64 = 256 * 1024;
/// FTS 内容命中上限
const FTS_HIT_LIMIT: i64 = 200;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub filename: String,
    pub snippet: String,
}

/// 递归收集 notes/ 下全部 .md（相对路径 + 绝对路径）。
fn collect_md(root: &Path, dir: &Path, base: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let rel = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            collect_md(root, &entry.path(), &rel, out);
        } else if name.ends_with(".md") {
            out.push((rel, entry.path()));
        }
    }
}

/// 打开（必要时创建）索引库并建表。
fn open_index(root: &Path) -> Result<Connection, String> {
    let dir = root.join(".toolbox");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建索引目录失败: {e}"))?;
    let conn = Connection::open(dir.join(INDEX_FILE))
        .map_err(|e| format!("打开搜索索引失败: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("设置索引超时失败: {e}"))?;
    let _ = conn.execute_batch("PRAGMA journal_mode=WAL;");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes_idx (
           path TEXT PRIMARY KEY,
           mtime_ns INTEGER NOT NULL,
           size INTEGER NOT NULL,
           fts_rowid INTEGER NOT NULL
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
           path UNINDEXED,
           content,
           tokenize = 'trigram'
         );",
    )
    .map_err(|e| format!("初始化搜索索引失败: {e}"))?;
    Ok(conn)
}

/// 增量同步：扫描 notes/ 全部 .md，与索引比对，只重建变化的条目、清理删除的。
fn sync_index(conn: &mut Connection, notes: &Path) -> Result<(), String> {
    let mut files = Vec::new();
    collect_md(notes, notes, NOTES_DIR, &mut files);

    let tx = conn.transaction().map_err(|e| format!("开启事务失败: {e}"))?;
    let mut seen: HashSet<String> = HashSet::new();
    for (rel, abs) in files {
        let meta = std::fs::metadata(&abs).map_err(|e| format!("读取元数据失败: {e}"))?;
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0);
        let size = meta.len() as i64;
        let old: Option<(i64, i64, i64)> = tx
            .query_row(
                "SELECT mtime_ns, size, fts_rowid FROM notes_idx WHERE path = ?1",
                [&rel],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("查询索引失败: {e}"))?;

        if let Some((om, os, _rowid)) = old {
            if om == mtime_ns && os == size {
                seen.insert(rel);
                continue;
            }
        }

        let Some(content) = read_index_content(&abs) else {
            continue;
        };
        if let Some((_, _, rowid)) = old {
            tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", [rowid])
                .map_err(|e| format!("清理旧索引失败: {e}"))?;
        }
        tx.execute(
            "INSERT INTO notes_fts(path, content) VALUES(?1, ?2)",
            params![rel, content],
        )
        .map_err(|e| format!("写入索引失败: {e}"))?;
        let new_rowid = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO notes_idx(path, mtime_ns, size, fts_rowid)
             VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET
               mtime_ns = excluded.mtime_ns, size = excluded.size, fts_rowid = excluded.fts_rowid",
            params![rel, mtime_ns, size, new_rowid],
        )
        .map_err(|e| format!("更新索引登记失败: {e}"))?;
        seen.insert(rel);
    }

    let stale: Vec<(String, i64)> = {
        let mut stmt = tx
            .prepare("SELECT path, fts_rowid FROM notes_idx")
            .map_err(|e| format!("准备清理查询失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("查询索引失败: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for (path, rowid) in stale {
        if !seen.contains(&path) {
            tx.execute("DELETE FROM notes_fts WHERE rowid = ?1", [rowid])
                .map_err(|e| format!("清理索引失败: {e}"))?;
            tx.execute("DELETE FROM notes_idx WHERE path = ?1", [path])
                .map_err(|e| format!("清理索引登记失败: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("提交索引失败: {e}"))?;
    Ok(())
}

/// 读取文件内容用于索引（截断超大文件）。
fn read_index_content(abs: &Path) -> Option<String> {
    use std::io::Read;
    let f = std::fs::File::open(abs).ok()?;
    let mut buf = Vec::new();
    if f.take(INDEX_READ_LIMIT).read_to_end(&mut buf).is_err() {
        return None;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 按首次命中位置切 snippet。
fn make_snippet(content: &str, q: &str) -> String {
    let lower = content.to_lowercase();
    let Some(idx) = lower.find(q) else {
        return "…".to_string();
    };
    let start = idx.saturating_sub(30);
    let end = (idx + q.len() + 60).min(content.len());
    let s = content.floor_char_boundary(start.min(content.len()));
    let e = content.floor_char_boundary(end.min(content.len()));
    content
        .get(s..e)
        .unwrap_or("")
        .replace('\n', " ")
        .trim()
        .to_string()
}

/// 全文搜索入口（带自愈）：索引损坏时删库重建一次。
pub fn search(vault: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    match search_once(vault, query) {
        Ok(hits) => Ok(hits),
        Err(first) => {
            reset_index(&PathBuf::from(vault));
            match search_once(vault, query) {
                Ok(hits) => Ok(hits),
                Err(_) => Err(format!("搜索索引异常，已尝试重建仍失败: {first}")),
            }
        }
    }
}

/// 删除索引库及其 WAL/SHM 派生文件。
fn reset_index(root: &Path) {
    for name in ["search-fts.sqlite", "search-fts.sqlite-wal", "search-fts.sqlite-shm"] {
        let _ = std::fs::remove_file(root.join(".toolbox").join(name));
    }
}

/// 单次搜索：同步索引 → 文件名匹配优先 → 内容匹配（FTS/LIKE）。
fn search_once(vault: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    let root = PathBuf::from(vault);
    let notes = root.join(NOTES_DIR);
    if !root.is_dir() || !notes.is_dir() {
        return Ok(Vec::new());
    }
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut conn = open_index(&root)?;
    sync_index(&mut conn, &notes)?;

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // 1. 文件名匹配（排最前）
    let like = format!("%{q}%");
    {
        let mut stmt = conn
            .prepare("SELECT path FROM notes_idx WHERE path LIKE ?1")
            .map_err(|e| format!("文件名搜索失败: {e}"))?;
        let rows = stmt
            .query_map([&like], |r| r.get::<_, String>(0))
            .map_err(|e| format!("文件名搜索失败: {e}"))?;
        for path in rows.filter_map(|r| r.ok()) {
            if seen.insert(path.clone()) {
                let filename = path.rsplit('/').next().unwrap_or(&path).to_string();
                hits.push(SearchHit {
                    path,
                    filename,
                    snippet: "文件名匹配".to_string(),
                });
            }
        }
    }

    // 2. 内容匹配
    let nchars = q.chars().count();
    if nchars >= 3 {
        let escaped = q.replace('"', "");
        let match_expr = format!("\"{escaped}\"");
        let fts_ok = (|| -> Result<(), String> {
            let mut stmt = conn
                .prepare("SELECT path FROM notes_fts WHERE notes_fts MATCH ?1 LIMIT ?2")
                .map_err(|e| format!("内容搜索失败: {e}"))?;
            let rows = stmt
                .query_map(params![match_expr, FTS_HIT_LIMIT], |r| r.get::<_, String>(0))
                .map_err(|e| format!("内容搜索失败: {e}"))?;
            for path in rows.filter_map(|r| r.ok()) {
                if seen.insert(path.clone()) {
                    let filename = path.rsplit('/').next().unwrap_or(&path).to_string();
                    let content =
                        std::fs::read_to_string(&root.join(&path)).unwrap_or_default();
                    hits.push(SearchHit {
                        path,
                        filename,
                        snippet: make_snippet(&content, &q.to_lowercase()),
                    });
                }
            }
            Ok(())
        })();
        if fts_ok.is_err() {
            linear_content_scan(&notes, q, &mut seen, &mut hits);
        }
    } else {
        linear_content_scan(&notes, q, &mut seen, &mut hits);
    }
    Ok(hits)
}

/// 短查询兜底：线性读文件内容匹配。
fn linear_content_scan(
    notes: &Path,
    q: &str,
    seen: &mut HashSet<String>,
    hits: &mut Vec<SearchHit>,
) {
    use std::io::Read;
    let mut files = Vec::new();
    collect_md(notes, notes, NOTES_DIR, &mut files);
    for (rel, abs) in files {
        if seen.contains(&rel) {
            continue;
        }
        let Ok(f) = std::fs::File::open(&abs) else {
            continue;
        };
        let mut buf = Vec::new();
        let _ = f.take(SEARCH_READ_LIMIT).read_to_end(&mut buf);
        let content = String::from_utf8_lossy(&buf);
        if content.to_lowercase().contains(&q.to_lowercase()) {
            let filename = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let snippet = make_snippet(&content, &q.to_lowercase());
            hits.push(SearchHit {
                path: rel,
                filename,
                snippet,
            });
        }
    }
}

/* ---------------- 插件入口 ---------------- */

pub struct SearchState {
    vault: String,
}

fn state_from_cfg(cfg: &Value) -> Result<SearchState, String> {
    let vault = cfg
        .get("vault")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if vault.is_empty() {
        return Err("缺少 vault 配置".to_string());
    }
    Ok(SearchState { vault })
}

/// search.query {query, limit?} → SearchHit[]（文件全文命中）
fn call(
    state: &mut SearchState,
    _host: tb_sdk::TbHostApi,
    _ctx: *mut std::ffi::c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "search.query" => {
            let query = params
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let hits = search(&state.vault, &query)?;
            serde_json::to_value(hits).map_err(|e| e.to_string())
        }
        _ => Err(format!("未知命令: {method}")),
    }
}

tb_sdk::tb_plugin!(SearchState, state_from_cfg, call);

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb-search-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join("notes")).unwrap();
        p
    }

    fn write_note(v: &Path, name: &str, content: &str) {
        std::fs::write(v.join("notes").join(name), content).unwrap();
    }

    #[test]
    fn fts_chinese_substring_hit() {
        let v = tmp_vault("fts");
        write_note(&v, "a.md", "# 工作日报\n今天完成了里程碑 M8。\n");
        write_note(&v, "b.md", "# 随便写写\n无关内容。\n");
        let hits = search(&v.to_string_lossy(), "工作日报").unwrap();
        assert_eq!(hits.len(), 1, "应只命中 a.md: {hits:?}");
        assert_eq!(hits[0].path, "notes/a.md");
        assert!(hits[0].snippet.contains("工作日报"), "snippet: {}", hits[0].snippet);
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn filename_match_first() {
        let v = tmp_vault("fname");
        write_note(&v, "项目计划.md", "# 正文\n");
        write_note(&v, "x.md", "提到项目计划的相关内容。\n");
        let hits = search(&v.to_string_lossy(), "项目计划").unwrap();
        assert_eq!(hits[0].path, "notes/项目计划.md", "文件名匹配应排最前: {hits:?}");
        assert_eq!(hits[0].snippet, "文件名匹配");
        assert!(hits.len() >= 2, "内容命中也应返回: {hits:?}");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn incremental_update_after_edit() {
        let v = tmp_vault("incr");
        write_note(&v, "n.md", "旧关键词甲甲甲。\n");
        assert_eq!(search(&v.to_string_lossy(), "旧关键词").unwrap().len(), 1);
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_note(&v, "n.md", "新关键词乙乙乙。\n");
        let hits = search(&v.to_string_lossy(), "新关键词").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(search(&v.to_string_lossy(), "旧关键词").unwrap().is_empty());
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn delete_cleans_index() {
        let v = tmp_vault("del");
        write_note(&v, "gone.md", "独特短语甲。\n");
        assert_eq!(search(&v.to_string_lossy(), "独特短语").unwrap().len(), 1);
        std::fs::remove_file(v.join("notes/gone.md")).unwrap();
        assert!(search(&v.to_string_lossy(), "独特短语").unwrap().is_empty());
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn short_query_falls_back_to_like() {
        let v = tmp_vault("short");
        write_note(&v, "n.md", "工作内容相关。\n");
        let hits = search(&v.to_string_lossy(), "工作").unwrap();
        assert_eq!(hits.len(), 1, "2 字查询应命中: {hits:?}");
        assert_eq!(hits[0].path, "notes/n.md");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn empty_query_safe() {
        let v = tmp_vault("empty");
        assert!(search(&v.to_string_lossy(), "  ").unwrap().is_empty());
        assert!(search(&v.to_string_lossy(), "随便").unwrap().is_empty());
        std::fs::remove_dir_all(&v).ok();
    }
}
