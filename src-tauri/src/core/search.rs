//! 全文搜索（宿主内嵌）：SQLite FTS5（trigram 分词器）索引。
//!
//! 由核心插件 core-search 迁回本体（搜索是系统级横切能力，不作为可装卸插件）。
//! 索引文件 `vault/.toolbox/search-fts.sqlite`；笔记是真源，索引可随时重建。
//! 命令入口：宿主 `search_all`（文件全文命中 + 搜索提供者插件聚合）。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// 笔记目录（vault/notes/）
// 索引范围已扩到整个 vault 根（顶栏全局搜索，用户决策）：collect_md 从 vault 根递归，
// 排除 IGNORED_DIRS（site/.toolbox/node_modules/target/.git）。
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

/// 递归最大深度：恶意/意外的万层嵌套目录会让纯递归栈溢出直接 abort 进程
/// （Rust 栈溢出不可捕获，无 panic 钩子）。超过上限的子树跳过。
const MAX_DEPTH: usize = 64;

/// 递归收集 notes/ 下全部 .md（相对路径 + 绝对路径）。
fn collect_md(root: &Path, dir: &Path, base: &str, out: &mut Vec<(String, PathBuf)>) {
    collect_md_depth(root, dir, base, out, 0);
}

fn collect_md_depth(
    root: &Path,
    dir: &Path,
    base: &str,
    out: &mut Vec<(String, PathBuf)>,
    depth: usize,
) {
    if depth > MAX_DEPTH {
        // 超深子树跳过（防栈溢出 abort）
        return;
    }
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
            collect_md_depth(root, &entry.path(), &rel, out, depth + 1);
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

/// 增量同步：扫描 vault 下全部 .md（排除 site/.toolbox/node_modules 等，见 IGNORED_DIRS），
/// 与索引比对，只重建变化的条目、清理删除的。**索引范围为整个 vault 根**——
/// 顶栏"全局搜索"搜索所有位置，不只 notes/（用户决策）。
fn sync_index(conn: &mut Connection, root: &Path) -> Result<(), String> {
    let mut files = Vec::new();
    collect_md(root, root, "", &mut files);

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
///
/// **不能直接 `content.to_lowercase().find(q)` 后拿字节索引切原串**：to_lowercase
/// 可能改变字符的字节数（如 `İ` → `i̇` 是 1 字符变 2 字符），索引会偏移。
/// 这里先做"逐字符大小写折叠 + 记录每个折叠后字符在原串的字节偏移"，
/// 再在折叠序列上做窗口匹配——匹配位置经偏移表映射回原串，正确且线性。
fn make_snippet(content: &str, q: &str) -> String {
    let qchars: Vec<char> = q.to_lowercase().chars().collect();
    if qchars.is_empty() {
        return "…".to_string();
    }
    // 折叠序列 + 原串字节偏移表（folded[i] 来自 content 的 byte_offsets[i] 处）
    let mut folded: Vec<char> = Vec::with_capacity(content.len());
    let mut byte_offsets: Vec<usize> = Vec::with_capacity(content.len());
    for (byte_idx, ch) in content.char_indices() {
        for fc in ch.to_lowercase() {
            folded.push(fc);
            byte_offsets.push(byte_idx);
        }
    }
    if folded.len() < qchars.len() {
        return "…".to_string();
    }
    // 滑动窗口匹配
    let mut start: Option<usize> = None;
    'outer: for s in 0..=(folded.len() - qchars.len()) {
        for (k, &qc) in qchars.iter().enumerate() {
            if folded[s + k] != qc {
                continue 'outer;
            }
        }
        start = Some(s);
        break;
    }
    let Some(start) = start else {
        return "…".to_string();
    };
    let s_folded = start.saturating_sub(30);
    let e_folded = (start + qchars.len() + 60).min(folded.len() - 1);
    let s = byte_offsets[s_folded];
    // 结束位置取到 e_folded 对应字符的末尾（起始字节 + 该字符 UTF-8 长度）
    let e_byte = byte_offsets[e_folded];
    let e = e_byte
        + content[e_byte..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(1);
    content
        .get(s..e.min(content.len()))
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
    // 全局搜索：只要工作区存在即可（不一定有 notes/ 目录）
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut conn = open_index(&root)?;
    sync_index(&mut conn, &root)?;

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // 1. 文件名匹配（排最前）。
    // LIKE 通配符转义：`%` 和 `_` 在 LIKE 里是通配符，搜索词含它们会多命中
    // （如搜 "100%" 会匹配所有含任意前缀后 "100" 的名字）。转义后配 ESCAPE。
    let like_escaped = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let like = format!("%{like_escaped}%");
    {
        let mut stmt = conn
            .prepare("SELECT path FROM notes_idx WHERE path LIKE ?1 ESCAPE '\\'")
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

    // 2. 内容匹配。
    // FTS5 短语查询包引号即可匹配整串；但引号/控制字符在 FTS 语法里有特殊含义
    // ——历史实现直接 `q.replace('"', "")` 删引号（语义失真：搜 a"b 变 ab），
    // 且纯标点查询会变成空短语让 FTS 报错、每次降级线性扫描。含这些字符时
    // 直接走线性扫描：保语义、不报错、无反复降级。
    let fts_safe = q.chars().all(|c| !c.is_control() && c != '"' && c != '\'');
    let nchars = q.chars().count();
    if nchars >= 3 && fts_safe {
        let match_expr = format!("\"{q}\"");
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
            linear_content_scan(&root, q, &mut seen, &mut hits);
        }
    } else {
        linear_content_scan(&root, q, &mut seen, &mut hits);
    }
    Ok(hits)
}

/// 短查询兜底：线性读文件内容匹配（搜索范围为整个 vault）。
fn linear_content_scan(
    root: &Path,
    q: &str,
    seen: &mut HashSet<String>,
    hits: &mut Vec<SearchHit>,
) {
    use std::io::Read;
    let mut files = Vec::new();
    collect_md(root, root, "", &mut files);
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

    #[test]
    fn global_search_covers_whole_vault() {
        // 全局搜索（用户决策）：vault 根下任意位置的 .md 都进索引（不只 notes/），
        // 但排除目录（.toolbox/site/node_modules 等）不索引。
        let v = tmp_vault("global");
        std::fs::create_dir_all(v.join("projects/foo")).unwrap();
        std::fs::write(v.join("projects/foo/README.md"), "项目说明：独特术语xyz。\n").unwrap();
        std::fs::write(v.join("notes/a.md"), "普通内容。\n").unwrap();
        let hits = search(&v.to_string_lossy(), "独特术语").unwrap();
        assert_eq!(hits.len(), 1, "应命中 projects/ 下的 md: {hits:?}");
        assert_eq!(hits[0].path, "projects/foo/README.md");

        std::fs::create_dir_all(v.join(".toolbox")).unwrap();
        std::fs::write(v.join(".toolbox/secret.md"), "独特术语xyz 在排除目录。\n").unwrap();
        let hits2 = search(&v.to_string_lossy(), "独特术语").unwrap();
        assert!(
            hits2.iter().all(|h| h.path != ".toolbox/secret.md"),
            "排除目录不应命中: {hits2:?}"
        );
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn like_wildcard_is_escaped() {
        // 回归：文件名 LIKE 通配符未转义时，搜 "100%" 的 `%` 会当通配符多命中
        let v = tmp_vault("likeesc");
        write_note(&v, "任务 100% 完成.md", "# x\n");
        write_note(&v, "任务 100 完成.md", "# x\n");
        let hits = search(&v.to_string_lossy(), "100%").unwrap();
        assert_eq!(hits.len(), 1, "只应命中真含 % 的名字: {hits:?}");
        assert_eq!(hits[0].path, "notes/任务 100% 完成.md");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn quote_query_uses_linear_scan() {
        // 回归：含引号的查询不再被删引号（语义失真），也不触发 FTS 报错反复降级
        let v = tmp_vault("qquote");
        write_note(&v, "a.md", "他说 \"你好世界\" 然后离开。\n");
        let hits = search(&v.to_string_lossy(), "\"你好世界\"").unwrap();
        assert!(
            hits.iter().any(|h| h.path == "notes/a.md"),
            "应命中含引号内容: {hits:?}"
        );
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn snippet_case_insensitive_hit() {
        let content = "今天天气很好，Hello World 值得记录。";
        let snip = make_snippet(content, "world");
        assert!(snip.contains("Hello World"), "snippet 应包含命中原文: {snip}");
    }

    #[test]
    fn snippet_safe_with_fold_length_change() {
        // 回归：大小写折叠改变字符字节数（İ 1 字符 → 折叠后 2 字符）时，
        // snippet 的偏移映射必须正确（历史实现拿 to_lowercase 的字节索引切
        // 原串会偏移）；至少不 panic 且包含命中词。
        let content = "İİİ İSTANBUL —— 折叠 后面内容填充文本。";
        let snip = make_snippet(content, "折叠");
        assert!(snip.contains("折叠"), "snippet: {snip}");
    }
}
