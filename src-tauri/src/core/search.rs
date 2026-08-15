//! 全文搜索：SQLite FTS5（trigram 分词器）。
//!
//! 背景：vault 笔记多时线性扫描（每文件读 256KB + 内存 lower）会拖慢搜索，
//! 这里用 SQLite FTS5 建倒排索引，索引文件放 `vault/.toolbox/search-fts.sqlite`。
//!
//! 设计：
//! - **trigram 分词器**：把文本切成 3-gram 序列，天然支持中文子串匹配
//!   （unicode61 会把"工作日报"当整个 token，"工作"搜不到）。代价是 <3 字符
//!   的查询拆不出 trigram，必须回退线性扫描。
//! - **增量同步**：搜索前对每个 .md stat（mtime_ns, size），与 `notes_idx` 表
//!   比对，不一致才重建该文件的 FTS 条目；已删除文件清理。stat 全量很快。
//! - **查询**：文件名 LIKE 匹配优先；内容 ≥3 字符走 FTS MATCH（短语=trigram
//!   序列连续匹配=精确子串），<3 字符回退内容 LIKE 线性扫描。
//! - snippet 不在 SQLite 里做：命中后只对命中的文件读一次、按首次命中位置切
//!   上下文（复用旧逻辑，质量可控）。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::notes::{collect_md, NOTES_DIR};

/// 索引数据库文件名（位于 vault/.toolbox/ 下）。
const INDEX_FILE: &str = "search-fts.sqlite";
/// 索引时每文件最多读取的字节数（超大文件截断索引，避免内存暴涨）
const INDEX_READ_LIMIT: u64 = 2 * 1024 * 1024;
/// snippet / 短词线性扫描每文件最多读取的字节数
const SEARCH_READ_LIMIT: u64 = 256 * 1024;
/// FTS 内容命中上限（超出截断，配合 snippet 重新读文件成本可控）
const FTS_HIT_LIMIT: i64 = 200;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub filename: String,
    pub snippet: String,
}

/// 打开（必要时创建）索引库并建表。
fn open_index(root: &Path) -> Result<Connection, String> {
    let dir = root.join(".toolbox");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建索引目录失败: {e}"))?;
    let conn = Connection::open(dir.join(INDEX_FILE))
        .map_err(|e| format!("打开搜索索引失败: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("设置索引超时失败: {e}"))?;
    // WAL：搜索/同步与可能并发的写入（多窗口、自动备份线程）不互相阻塞
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
        let old: Option<(i64, i64, i64)> = conn
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
                continue; // 未变化，跳过
            }
        }

        // 内容变化或新文件：重建 FTS 条目
        let content = read_index_content(&abs)?;
        if let Some((_, _, rowid)) = old {
            conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", [rowid])
                .map_err(|e| format!("清理旧索引失败: {e}"))?;
        }
        conn.execute(
            "INSERT INTO notes_fts(path, content) VALUES(?1, ?2)",
            params![rel, content],
        )
        .map_err(|e| format!("写入索引失败: {e}"))?;
        let new_rowid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO notes_idx(path, mtime_ns, size, fts_rowid)
             VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET
               mtime_ns = excluded.mtime_ns, size = excluded.size, fts_rowid = excluded.fts_rowid",
            params![rel, mtime_ns, size, new_rowid],
        )
        .map_err(|e| format!("更新索引登记失败: {e}"))?;
        seen.insert(rel);
    }

    // 清理：索引里存在但磁盘上已删除的
    let stale: Vec<(String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT path, fts_rowid FROM notes_idx")
            .map_err(|e| format!("准备清理查询失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| format!("查询索引失败: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for (path, rowid) in stale {
        if !seen.contains(&path) {
            conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", [rowid])
                .map_err(|e| format!("清理索引失败: {e}"))?;
            conn.execute("DELETE FROM notes_idx WHERE path = ?1", [path])
                .map_err(|e| format!("清理索引登记失败: {e}"))?;
        }
    }
    Ok(())
}

/// 读取文件内容用于索引（截断超大文件）。
fn read_index_content(abs: &Path) -> Result<String, String> {
    use std::io::Read;
    let f = std::fs::File::open(abs).map_err(|e| format!("打开失败: {e}"))?;
    let mut buf = Vec::new();
    let _ = f.take(INDEX_READ_LIMIT).read_to_end(&mut buf);
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 按首次命中位置切 snippet（复用旧搜索的切法）。
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

/// 全文搜索入口：同步索引 → 文件名匹配优先 → 内容匹配（FTS/LIKE）。
pub fn search(vault: &str, query: &str) -> Result<Vec<SearchHit>, String> {
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
                let filename = path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&path)
                    .to_string();
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
        // FTS trigram 短语查询 = 精确子串匹配（引号防注入/防语法错误）
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
                    // 读文件切 snippet（命中文件数少，成本可控）
                    let content = std::fs::read_to_string(&root.join(&path))
                        .unwrap_or_default();
                    hits.push(SearchHit {
                        path,
                        filename,
                        snippet: make_snippet(&content, q),
                    });
                }
            }
            Ok(())
        })();
        // FTS 语法异常（罕见）→ 回退线性扫描
        if fts_ok.is_err() {
            linear_content_scan(&notes, q, &mut seen, &mut hits);
        }
    } else {
        // <3 字符：trigram 拆不出，回退内容 LIKE 线性扫描
        linear_content_scan(&notes, q, &mut seen, &mut hits);
    }
    Ok(hits)
}

/// 短查询兜底：线性读文件内容匹配（受 SEARCH_READ_LIMIT 限制）。
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("toolbox-search-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join("notes")).unwrap();
        p
    }

    fn write_note(v: &Path, name: &str, content: &str) {
        std::fs::write(v.join("notes").join(name), content).unwrap();
    }    /// 中文子串搜索：3+ 字应命中 FTS，snippet 含上下文。
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

    /// 文件名匹配优先于内容匹配。
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

    /// 增量更新：修改文件内容后重新搜索应反映新内容。
    #[test]
    fn incremental_update_after_edit() {
        let v = tmp_vault("incr");
        write_note(&v, "n.md", "旧关键词甲甲甲。\n");
        assert!(search(&v.to_string_lossy(), "旧关键词").unwrap().len() == 1);
        // 修改内容（mtime 变化）
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_note(&v, "n.md", "新关键词乙乙乙。\n");
        let hits = search(&v.to_string_lossy(), "新关键词").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(search(&v.to_string_lossy(), "旧关键词").unwrap().is_empty());

        std::fs::remove_dir_all(&v).ok();
    }

    /// 删除文件后索引清理，不再命中。
    #[test]
    fn delete_cleans_index() {
        let v = tmp_vault("del");
        write_note(&v, "gone.md", "独特短语甲。\n");
        assert!(search(&v.to_string_lossy(), "独特短语").unwrap().len() == 1);
        std::fs::remove_file(v.join("notes/gone.md")).unwrap();
        assert!(search(&v.to_string_lossy(), "独特短语").unwrap().is_empty());

        std::fs::remove_dir_all(&v).ok();
    }

    /// 短查询（<3 字符）回退 LIKE 线性扫描，仍能命中。
    #[test]
    fn short_query_falls_back_to_like() {
        let v = tmp_vault("short");
        write_note(&v, "n.md", "工作内容相关。\n");
        let hits = search(&v.to_string_lossy(), "工作").unwrap();
        assert_eq!(hits.len(), 1, "2 字查询应命中: {hits:?}");
        assert_eq!(hits[0].path, "notes/n.md");

        std::fs::remove_dir_all(&v).ok();
    }

    /// 空查询 / 空 vault 安全返回。
    #[test]
    fn empty_query_safe() {
        let v = tmp_vault("empty");
        assert!(search(&v.to_string_lossy(), "  ").unwrap().is_empty());
        assert!(search(&v.to_string_lossy(), "随便").unwrap().is_empty());

        std::fs::remove_dir_all(&v).ok();
    }
}
