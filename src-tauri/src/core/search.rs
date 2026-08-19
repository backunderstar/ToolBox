//! 全文搜索（宿主内嵌）：SQLite FTS5（trigram 分词器）索引。
//!
//! 由核心插件 core-search 迁回本体（搜索是系统级横切能力，不作为可装卸插件）。
//! 索引文件 `vault/.toolbox/search-fts.sqlite`；笔记是真源，索引可随时重建。
//! 命令入口：宿主 `search_all`（文件全文命中 + 搜索提供者插件聚合）。

use pinyin::ToPinyin;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

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
/// 搜索结果整体上限（D4）：文件名/拼音精确命中占满后不再收集内容命中，
/// 防止 vault 大时一次返回几百条拖慢前端渲染；内容命中只填剩余名额。
const MAX_TOTAL_HITS: usize = 200;

/// 索引同步缓存（D1）：3 秒窗口内的连续搜索跳过全量增量同步
/// （collect_md 递归 + 全量文件 stat + 内容比对），vault 大时搜索更跟手。
/// 正确性完备（无"刚建的文件搜不到"回归）：
/// - 目录树签名探测：窗口内跳过前重算目录签名（只 read_dir + stat 目录，
///   远轻于全量 sync）。目录条目增删/改名会更新目录 mtime（NTFS/FAT 可靠）
///   → 签名变化 → 强制重同步；
/// - 空结果兜底：文件**内容**修改不改变目录签名（条目未增删），窗口内跳过
///   后若结果为空 → 强制重同步再查一次（修改后立即搜索新内容仍命中）；
/// - 命中存在性检查（file_mtime / read_head）：删除后立即搜索不出幽灵结果。
const SYNC_WINDOW: Duration = Duration::from_secs(3);

struct SyncCache {
    /// vault 路径（Windows 大小写不敏感，统一小写）
    key: String,
    /// 上次同步完成时的目录树签名（条目级变化检测）
    dir_sig: String,
    at: Instant,
}

static SYNC_CACHE: OnceLock<Mutex<Option<SyncCache>>> = OnceLock::new();

/// D1：带缓存的索引同步。返回是否跳过了全量 sync。
fn maybe_sync_index(conn: &mut Connection, root: &Path) -> Result<bool, String> {
    let key = root.to_string_lossy().to_lowercase();
    let now = Instant::now();
    let mut g = SYNC_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?;
    // 窗口内 + 目录树未变 → 跳过全量 sync（文件内容修改不影响目录签名，
    // 由 search_once 的空结果兜底补偿）
    if let Some(c) = g.as_ref() {
        if c.key == key && now.duration_since(c.at) < SYNC_WINDOW && c.dir_sig == dir_tree_signature(root) {
            return Ok(true);
        }
    }
    sync_index(conn, root)?;
    *g = Some(SyncCache {
        key,
        dir_sig: dir_tree_signature(root),
        at: now,
    });
    Ok(false)
}

/// 目录树签名：所有目录的 `(相对路径, 目录 mtime_ns)` 列表哈希。
/// 目录条目增删/改名会更新目录 mtime（NTFS/FAT/exFAT 可靠），文件内容
/// 修改不更新——正好覆盖"需要强制重同步"的条目级变化，成本远低于
/// 全量 sync（无文件 stat、无内容读取、无 SQLite 写）。
fn dir_tree_signature(root: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut sig: Vec<String> = Vec::new();
    collect_dirs(root, "", &mut sig, 0);
    sig.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for s in sig {
        s.hash(&mut h);
    }
    h.finish().to_string()
}

fn collect_dirs(
    dir: &Path,
    base: &str,
    out: &mut Vec<String>,
    depth: usize,
) {
    if depth > MAX_DEPTH {
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
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mtime_ns = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        out.push(format!("{rel}|{mtime_ns}"));
        collect_dirs(&entry.path(), &rel, out, depth + 1);
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub filename: String,
    pub snippet: String,
    /// 文件修改时间（UNIX 毫秒）：搜索结果按"最近修改"排序用
    /// （用户优化项：文件名/内容命中在各自阶段内按 mtime 降序）。
    pub mtime: i64,
}

/// 递归最大深度：恶意/意外的万层嵌套目录会让纯递归栈溢出直接 abort 进程
/// （Rust 栈溢出不可捕获，无 panic 钩子）。超过上限的子树跳过。
const MAX_DEPTH: usize = 64;

/// vault 内需要索引的非 md 数据文件：清单（data/checklists/*.json）与待办
/// （data/todos/todos.json）内容可被全局搜索命中（用户优化项：搜到清单/待办）。
fn is_indexed_json(rel: &str) -> bool {
    rel.ends_with(".json")
        && (rel.starts_with("data/checklists/") || rel == "data/todos/todos.json")
}

/// 文件名的拼音键（全拼 + 首字母，均小写、去空白），用于拼音搜索：
/// - 全拼："项目计划" → "xiangmujihua"
/// - 首字母："项目计划" → "xmjh"
///   非汉字字符（ASCII 字母/数字）原样保留并与拼音串串联——"API 计划" 可被
///   "api" 命中。多音字取第一个读音（pinyin crate 默认行为），足够日常使用。
fn pinyin_keys(stem: &str) -> (String, String) {
    let mut full = String::new();
    let mut initials = String::new();
    for ch in stem.chars() {
        match ch.to_pinyin() {
            Some(py) => {
                full.push_str(py.plain());
                initials.push_str(py.first_letter());
            }
            None => {
                if !ch.is_whitespace() {
                    let c = ch.to_ascii_lowercase();
                    full.push(c);
                    initials.push(c);
                }
            }
        }
    }
    (full, initials)
}

/// LIKE 通配符转义（`%`/`_` 在 LIKE 里是通配符，搜索词含它们会多命中）。
fn escape_like(q: &str) -> String {
    q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// 递归收集 notes/ 下全部 .md（相对路径 + 绝对路径）。
fn collect_md(dir: &Path, base: &str, out: &mut Vec<(String, PathBuf)>) {
    collect_md_depth(dir, base, out, 0);
}

fn collect_md_depth(
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
            collect_md_depth(&entry.path(), &rel, out, depth + 1);
        } else if name.ends_with(".md") || is_indexed_json(&rel) {
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
           fts_rowid INTEGER NOT NULL,
           pinyin_full TEXT NOT NULL DEFAULT '',
           pinyin_initials TEXT NOT NULL DEFAULT ''
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
           path UNINDEXED,
           content,
           tokenize = 'trigram'
         );",
    )
    .map_err(|e| format!("初始化搜索索引失败: {e}"))?;
    // 旧库迁移：早期 schema 没有拼音列（pinyin 搜索 2026-08 引入）。
    // ALTER 重复执行会报 duplicate column，忽略即可（幂等迁移）。
    for alter in [
        "ALTER TABLE notes_idx ADD COLUMN pinyin_full TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE notes_idx ADD COLUMN pinyin_initials TEXT NOT NULL DEFAULT ''",
    ] {
        let _ = conn.execute_batch(alter);
    }
    Ok(conn)
}

/// 增量同步：扫描 vault 下全部 .md（排除 site/.toolbox/node_modules 等，见 IGNORED_DIRS），
/// 与索引比对，只重建变化的条目、清理删除的。**索引范围为整个 vault 根**——
/// 顶栏"全局搜索"搜索所有位置，不只 notes/（用户决策）。
fn sync_index(conn: &mut Connection, root: &Path) -> Result<(), String> {
    let mut files = Vec::new();
    collect_md(root, "", &mut files);

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
        let old: Option<(i64, i64, i64, String)> = tx
            .query_row(
                "SELECT mtime_ns, size, fts_rowid, pinyin_full FROM notes_idx WHERE path = ?1",
                [&rel],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|e| format!("查询索引失败: {e}"))?;

        if let Some((om, os, _rowid, pinyin_full)) = old.as_ref() {
            // 拼音列非空才可跳过：旧库迁移后首轮需补拼音（内容未变但拼音为空）
            if *om == mtime_ns && *os == size && !pinyin_full.is_empty() {
                seen.insert(rel);
                continue;
            }
        }

        // 文件名拼音键（全拼 + 首字母），存索引供拼音搜索
        let stem = rel
            .rsplit('/')
            .next()
            .unwrap_or(&rel)
            .rsplit_once('.')
            .map(|(s, _)| s)
            .unwrap_or(&rel);
        let (pinyin_full, pinyin_initials) = pinyin_keys(stem);

        let Some(content) = read_index_content(&abs) else {
            continue;
        };
        if let Some((_, _, rowid, _)) = old.as_ref() {
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
            "INSERT INTO notes_idx(path, mtime_ns, size, fts_rowid, pinyin_full, pinyin_initials)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(path) DO UPDATE SET
               mtime_ns = excluded.mtime_ns, size = excluded.size,
               fts_rowid = excluded.fts_rowid,
               pinyin_full = excluded.pinyin_full,
               pinyin_initials = excluded.pinyin_initials",
            params![rel, mtime_ns, size, new_rowid, pinyin_full, pinyin_initials],
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

/// 文件修改时间（UNIX 毫秒）。不存在/读取失败返回 None——
/// 命中路径检查用：索引可能陈旧（删除/移动后未同步），跳过不存在的路径。
fn file_mtime(abs: &Path) -> Option<i64> {
    std::fs::metadata(abs)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

/// 读取文件头部内容（上限 limit 字节，防大文件拖慢搜索）+ 修改时间。
/// 内容命中做 snippet 时用（与线性扫描的 SEARCH_READ_LIMIT 一致；
/// 历史实现 FTS 分支 `read_to_string` 读全文，大文件多命中时明显变慢）。
fn read_head(abs: &Path, limit: u64) -> Option<(String, i64)> {
    use std::io::Read;
    let f = std::fs::File::open(abs).ok()?;
    let mtime_ms = f
        .metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut buf = Vec::new();
    if f.take(limit).read_to_end(&mut buf).is_err() {
        return None;
    }
    Some((String::from_utf8_lossy(&buf).into_owned(), mtime_ms))
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

/// 单次搜索：同步索引（带缓存）→ 收集命中（文件名/拼音/内容，阶段内按 mtime 排序）。
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
    let skipped = maybe_sync_index(&mut conn, &root)?;
    let mut hits = collect_hits(&conn, &root, q)?;
    // D1 兜底：窗口内跳过同步且结果为空 → 强制重同步再查一次。
    // 新增/修改文件后立即搜索时索引可能陈旧，空结果可能是漏报（
    // "搜不到刚建的文件"正是历史缺陷，不能因缓存回归）。
    if skipped && hits.is_empty() {
        sync_index(&mut conn, &root)?;
        hits = collect_hits(&conn, &root, q)?;
    }
    Ok(hits)
}

/// 收集全部命中：文件名 → 拼音 → 内容（阶段权重优先，阶段内按修改时间降序）。
/// 每个命中做**存在性检查**：索引可能陈旧（删除/移动后未同步），
/// 路径已不存在的命中直接跳过——"删除后立即搜索"不会出现幽灵结果。
fn collect_hits(conn: &Connection, root: &Path, q: &str) -> Result<Vec<SearchHit>, String> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // 1. 文件名匹配（排最前）。
    // LIKE 通配符转义：`%` 和 `_` 在 LIKE 里是通配符，搜索词含它们会多命中
    // （如搜 "100%" 会匹配所有含任意前缀后 "100" 的名字）。转义后配 ESCAPE。
    let like_escaped = escape_like(q);
    let like = format!("%{like_escaped}%");
    {
        let mut fname: Vec<SearchHit> = Vec::new();
        let mut stmt = conn
            .prepare("SELECT path FROM notes_idx WHERE path LIKE ?1 ESCAPE '\\'")
            .map_err(|e| format!("文件名搜索失败: {e}"))?;
        let rows = stmt
            .query_map([&like], |r| r.get::<_, String>(0))
            .map_err(|e| format!("文件名搜索失败: {e}"))?;
        for path in rows.filter_map(|r| r.ok()) {
            if seen.insert(path.clone()) {
                let abs = root.join(&path);
                if let Some(m) = file_mtime(&abs) {
                    let filename = path.rsplit('/').next().unwrap_or(&path).to_string();
                    fname.push(SearchHit {
                        path,
                        filename,
                        snippet: "文件名匹配".to_string(),
                        mtime: m,
                    });
                }
            }
        }
        // D2：阶段内按最近修改降序（稳定排序，同时间戳保持原顺序）
        fname.sort_by_key(|h| std::cmp::Reverse(h.mtime));
        hits.extend(fname);
    }
    // D4：文件名精确命中已占满上限 → 直接返回（精确命中优先，
    // 内容命中不应挤掉文件名命中；同时省去后续阶段的 stat/读文件成本）
    if hits.len() >= MAX_TOTAL_HITS {
        hits.truncate(MAX_TOTAL_HITS);
        return Ok(hits);
    }

    // 1b. 文件名拼音匹配（首字母/全拼）：query 全为 ASCII 字母时尝试，
    // 如 "xmjh" 命中"项目计划.md"、"xiangmu" 命中"项目…"。空格忽略（"xm jh" = "xmjh"）。
    // 注：不能把拼音查询直接写进上面的 LIKE（原文件名字符不含拼音）。
    let q_compact: String = q
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    if !q_compact.is_empty() && q_compact.chars().all(|c| c.is_ascii_alphabetic()) {
        let pinyin_like = format!("%{}%", escape_like(&q_compact));
        let mut pinyin: Vec<SearchHit> = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT path, pinyin_initials, pinyin_full FROM notes_idx
                 WHERE pinyin_initials LIKE ?1 ESCAPE '\\' OR pinyin_full LIKE ?1 ESCAPE '\\'",
            )
            .map_err(|e| format!("拼音搜索失败: {e}"))?;
        let rows = stmt
            .query_map([&pinyin_like], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(|e| format!("拼音搜索失败: {e}"))?;
        for (path, initials, full) in rows.filter_map(|r| r.ok()) {
            if seen.insert(path.clone()) {
                // 首字母命中优先标注（用户输入更短，意图更明确）
                let kind = if initials.contains(&q_compact) {
                    "拼音首字母"
                } else {
                    let _ = full; // 全拼命中（含混合字符场景）
                    "拼音"
                };
                let abs = root.join(&path);
                if let Some(m) = file_mtime(&abs) {
                    let filename = path.rsplit('/').next().unwrap_or(&path).to_string();
                    pinyin.push(SearchHit {
                        path,
                        filename,
                        snippet: format!("文件名匹配（{kind}）"),
                        mtime: m,
                    });
                }
            }
        }
        pinyin.sort_by_key(|h| std::cmp::Reverse(h.mtime));
        hits.extend(pinyin);
    }
    // D4：拼音命中占满剩余名额 → 不再收集内容命中
    if hits.len() >= MAX_TOTAL_HITS {
        hits.truncate(MAX_TOTAL_HITS);
        return Ok(hits);
    }

    // 2. 内容匹配（只填剩余名额；无名额则跳过，省去读文件成本）。
    let budget = MAX_TOTAL_HITS - hits.len();
    if budget == 0 {
        return Ok(hits);
    }
    // FTS5 短语查询包引号即可匹配整串；但引号/控制字符在 FTS 语法里有特殊含义
    // ——历史实现直接 `q.replace('"', "")` 删引号（语义失真：搜 a"b 变 ab），
    // 且纯标点查询会变成空短语让 FTS 报错、每次降级线性扫描。含这些字符时
    // 直接走线性扫描：保语义、不报错、无反复降级。
    let fts_safe = q.chars().all(|c| !c.is_control() && c != '"' && c != '\'');
    let nchars = q.chars().count();
    let mut content: Vec<SearchHit> = Vec::new();
    if nchars >= 3 && fts_safe {
        let match_expr = format!("\"{q}\"");
        let fts_ok = (|| -> Result<(), String> {
            let mut stmt = conn
                .prepare("SELECT path FROM notes_fts WHERE notes_fts MATCH ?1 LIMIT ?2")
                .map_err(|e| format!("内容搜索失败: {e}"))?;
            let rows = stmt
                .query_map(params![match_expr, budget as i64], |r| r.get::<_, String>(0))
                .map_err(|e| format!("内容搜索失败: {e}"))?;
            for path in rows.filter_map(|r| r.ok()) {
                if seen.insert(path.clone()) {
                    let abs = root.join(&path);
                    // D3：摘要读前 SEARCH_READ_LIMIT 字节（不再 read_to_string 全文，
                    // 大文件多命中时拖慢搜索）；读不到 = 文件已删除，跳过陈旧索引。
                    if let Some((text, m)) = read_head(&abs, SEARCH_READ_LIMIT) {
                        let filename = path.rsplit('/').next().unwrap_or(&path).to_string();
                        content.push(SearchHit {
                            path,
                            filename,
                            snippet: make_snippet(&text, &q.to_lowercase()),
                            mtime: m,
                        });
                    }
                }
            }
            Ok(())
        })();
        if fts_ok.is_err() {
            linear_content_scan(root, q, &mut seen, &mut content);
        }
    } else {
        linear_content_scan(root, q, &mut seen, &mut content);
    }
    content.sort_by_key(|h| std::cmp::Reverse(h.mtime));
    content.truncate(budget);
    hits.extend(content);
    Ok(hits)
}

/// 短查询兜底：线性读文件内容匹配（搜索范围为整个 vault）。
/// 复用 read_head（256KB 上限 + 拿 mtime），命中带修改时间供排序。
fn linear_content_scan(
    root: &Path,
    q: &str,
    seen: &mut HashSet<String>,
    hits: &mut Vec<SearchHit>,
) {
    let mut files = Vec::new();
    collect_md(root, "", &mut files);
    let ql = q.to_lowercase();
    for (rel, abs) in files {
        if seen.contains(&rel) {
            continue;
        }
        let Some((content, mtime)) = read_head(&abs, SEARCH_READ_LIMIT) else {
            continue;
        };
        if content.to_lowercase().contains(&ql) {
            let filename = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let snippet = make_snippet(&content, &ql);
            hits.push(SearchHit {
                path: rel,
                filename,
                snippet,
                mtime,
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
    fn pinyin_initials_match() {
        // 拼音首字母：搜 "xmjh" 命中 "项目计划.md"
        let v = tmp_vault("pyinit");
        write_note(&v, "项目计划.md", "# 正文\n");
        write_note(&v, "随便.md", "# 正文\n");
        let hits = search(&v.to_string_lossy(), "xmjh").unwrap();
        assert_eq!(hits.len(), 1, "应只命中项目计划: {hits:?}");
        assert_eq!(hits[0].path, "notes/项目计划.md");
        assert!(
            hits[0].snippet.contains("拼音首字母"),
            "snippet 应标注拼音命中: {}",
            hits[0].snippet
        );
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn pinyin_full_match() {
        // 拼音全拼：搜 "xiangmujihua" 命中 "项目计划.md"（含空白折叠 "xm jh" 亦可）
        let v = tmp_vault("pyfull");
        write_note(&v, "项目计划.md", "# 正文\n");
        let hits = search(&v.to_string_lossy(), "xiangmujihua").unwrap();
        assert_eq!(hits.len(), 1, "全拼应命中: {hits:?}");
        let hits2 = search(&v.to_string_lossy(), "xm jh").unwrap();
        assert_eq!(hits2.len(), 1, "带空格的首字母也应命中: {hits2:?}");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn pinyin_mixed_with_ascii() {
        // 混合名：非汉字原样保留 → "API 计划" 可被 "api" 命中
        let v = tmp_vault("pymix");
        write_note(&v, "API 计划.md", "# x\n");
        let hits = search(&v.to_string_lossy(), "api").unwrap();
        assert_eq!(hits.len(), 1, "ASCII 部分应命中: {hits:?}");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn checklist_json_content_hit() {
        // 清单数据内容可被搜索（用户优化项：搜到清单/待办内容）
        let v = tmp_vault("cljson");
        std::fs::create_dir_all(v.join("data/checklists")).unwrap();
        std::fs::write(
            v.join("data/checklists/采购.json"),
            "{\"title\": \"采购清单\", \"items\": [{\"text\": \"买独特术语zzz\"}]}",
        )
        .unwrap();
        write_note(&v, "a.md", "# 普通内容\n");
        let hits = search(&v.to_string_lossy(), "独特术语zzz").unwrap();
        assert_eq!(hits.len(), 1, "应命中清单 json: {hits:?}");
        assert_eq!(hits[0].path, "data/checklists/采购.json");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn todos_json_content_hit() {
        let v = tmp_vault("todosjson");
        std::fs::create_dir_all(v.join("data/todos")).unwrap();
        std::fs::write(
            v.join("data/todos/todos.json"),
            "[{\"text\": \"待办 独特术语aaa\", \"done\": false}]",
        )
        .unwrap();
        let hits = search(&v.to_string_lossy(), "独特术语aaa").unwrap();
        assert_eq!(hits.len(), 1, "应命中 todos.json: {hits:?}");
        assert_eq!(hits[0].path, "data/todos/todos.json");
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

    #[test]
    fn content_hits_sorted_by_mtime_desc() {
        // D2：内容命中同一关键词的两个文件，最近修改的排前（阶段内 mtime 降序）
        let v = tmp_vault("mtimesort");
        write_note(&v, "a.md", "独特词w1。\n");
        std::thread::sleep(std::time::Duration::from_millis(50));
        write_note(&v, "b.md", "独特词w1。\n");
        let hits = search(&v.to_string_lossy(), "独特词w1").unwrap();
        assert_eq!(hits.len(), 2, "两个文件都应命中: {hits:?}");
        assert_eq!(hits[0].path, "notes/b.md", "最近修改的应排前: {hits:?}");
        assert_eq!(hits[1].path, "notes/a.md", "较早的应排后: {hits:?}");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn filename_hits_sorted_by_mtime_desc() {
        // D2：文件名命中同一关键词的两个文件，最近修改的排前
        let v = tmp_vault("mtimesortf");
        write_note(&v, "任务甲.md", "# x\n");
        std::thread::sleep(std::time::Duration::from_millis(50));
        write_note(&v, "任务乙.md", "# x\n");
        let hits = search(&v.to_string_lossy(), "任务").unwrap();
        assert_eq!(hits.len(), 2, "两个文件名都应命中: {hits:?}");
        assert_eq!(hits[0].path, "notes/任务乙.md", "最近修改的应排前: {hits:?}");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn d1_window_skip_still_detects_new_file() {
        // D1：窗口内**新增文件**（目录条目变化 → 目录签名变化）→ 强制重同步，
        // 立即搜到——不得出现"刚建的文件搜不到"回归（历史缺陷）。
        let v = tmp_vault("d1new");
        write_note(&v, "a.md", "独特词d1。\n");
        let _ = search(&v.to_string_lossy(), "独特词d1").unwrap(); // 首次：全量 sync
        write_note(&v, "b.md", "独特词d1。\n"); // 新增文件 → 目录 mtime 变化
        let hits = search(&v.to_string_lossy(), "独特词d1").unwrap();
        assert_eq!(hits.len(), 2, "窗口内新增文件应立即搜到（目录签名检测）: {hits:?}");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn d1_window_skip_empty_result_forces_resync() {
        // D1：窗口内文件**内容修改**（目录树不变 → 签名一致 → 跳过 sync），
        // 搜索新内容结果为空 → 空结果兜底强制重同步 → 命中。
        let v = tmp_vault("d1edit");
        write_note(&v, "n.md", "旧词aa。\n");
        let _ = search(&v.to_string_lossy(), "旧词aa").unwrap(); // 首次：全量 sync
        std::thread::sleep(std::time::Duration::from_millis(20));
        write_note(&v, "n.md", "新词bb。\n"); // 内容修改，目录条目未变
        let hits = search(&v.to_string_lossy(), "新词bb").unwrap();
        assert_eq!(hits.len(), 1, "窗口内内容修改后搜索新词应立即命中: {hits:?}");
        assert_eq!(hits[0].path, "notes/n.md");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn total_hits_capped_at_limit() {
        // D4：整体结果上限——文件名命中远超上限时只返回前 MAX_TOTAL_HITS 条
        let v = tmp_vault("cap");
        for i in 0..250 {
            write_note(&v, &format!("任务{i:03}.md"), "# x\n");
        }
        let hits = search(&v.to_string_lossy(), "任务").unwrap();
        assert_eq!(
            hits.len(),
            200,
            "整体上限应生效（200）: {}",
            hits.len()
        );
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn filename_saturation_skips_content_stage() {
        // D4：文件名精确命中占满上限后跳过内容阶段（精确命中优先，
        // 内容命中不挤掉文件名命中）
        let v = tmp_vault("capsat");
        for i in 0..250 {
            write_note(&v, &format!("任务{i:03}.md"), "# x\n");
        }
        // 文件名不含"任务"、内容命中"任务"的文件：不应出现在结果里
        write_note(&v, "other.md", "任务 相关内容。\n");
        let hits = search(&v.to_string_lossy(), "任务").unwrap();
        assert_eq!(hits.len(), 200, "占满后应截断: {}", hits.len());
        assert!(
            hits.iter().all(|h| h.path.starts_with("notes/任务")),
            "内容命中不应挤掉文件名命中: {hits:?}"
        );
        std::fs::remove_dir_all(&v).ok();
    }
}
