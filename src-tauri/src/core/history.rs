//! 版本历史：vault 内嵌 git 仓库（libgit2，无需用户安装 git）。
//!
//! - 仓库位置：`vault/.git`（标准仓库，可用 git CLI / VS Code 直接查看）
//! - 忽略项：`.toolbox/`（索引/备份）、`site/`（博客生成物，可重建）、`node_modules/`
//! - 自动提交：编辑类命令成功后 `mark_dirty` → 防抖 15s → 后台线程提交快照
//! - 回滚：先提交当前未提交变更（不丢数据），再 hard reset 到目标版本；
//!   未跟踪的新文件保留（不做 clean，避免误删用户数据）
//!
//! 并发：所有提交（防抖线程/手动/回滚前保存）经 `COMMIT_LOCK` 串行化，
//! 避免 libgit2 索引锁竞争。

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 自动提交防抖：停止编辑这么久后落盘为一次提交
const DEBOUNCE: Duration = Duration::from_secs(15);
/// 列表返回上限
const LIST_LIMIT: usize = 200;
/// 本地提交签名（无远程，纯本地仓库）
const AUTHOR: (&str, &str) = ("ToolBox", "toolbox@local");

/// vault/.gitignore 内容：不纳入版本控制的部分
const GITIGNORE: &str = ".toolbox/\nsite/\nnode_modules/\n";
/// vault/.gitattributes 内容：所有文件按原始字节处理（`-text` 关闭行尾转换）。
/// 数据仓库必须字节保真——libgit2 在 Windows 默认会在 checkout 时把 LF 转成
/// CRLF，这会让"回滚"静默改写用户文件的行尾。
const GITATTRIBUTES: &str = "* -text\n";

/* ---------------- 数据结构 ---------------- */

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short: String,
    pub message: String,
    /// unix 秒（git 签名时间）
    pub time: i64,
    /// 相对首父提交变更的文件数（根提交为全部文件数）
    pub files: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// A 新增 / M 修改 / D 删除 / R 重命名
    pub status: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub initialized: bool,
    pub last_commit: Option<CommitInfo>,
    /// 未提交的变更条目数（含未跟踪文件）
    pub pending: usize,
}

/// 防抖状态：vault 路径 → 上次标记时间。
/// 进程级单例（`OnceLock`）：编辑命令无需 AppHandle 即可标记，
/// 自动提交线程 / 退出冲刷共用同一份状态。
pub struct DirtyState {
    map: Mutex<HashMap<String, Instant>>,
    cv: Condvar,
}

impl Default for DirtyState {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            cv: Condvar::new(),
        }
    }
}

fn dirty_state() -> &'static DirtyState {
    static DIRTY: OnceLock<DirtyState> = OnceLock::new();
    DIRTY.get_or_init(DirtyState::default)
}

/// 提交全局互斥：防抖线程、手动提交、回滚前保存互不竞争 libgit2 索引锁
static COMMIT_LOCK: Mutex<()> = Mutex::new(());

/* ---------------- 仓库打开 / 初始化 ---------------- */

fn open_repo(vault: &str) -> Result<git2::Repository, String> {
    let root = PathBuf::from(vault);
    if !root.is_dir() {
        return Err(format!("工作区不存在: {vault}"));
    }
    git2::Repository::open(&root).map_err(|e| format!("打开仓库失败: {e}"))
}

fn ensure_ignore_files(root: &Path) {
    let gi = root.join(".gitignore");
    if !gi.exists() {
        let _ = std::fs::write(&gi, GITIGNORE);
    }
    let ga = root.join(".gitattributes");
    if !ga.exists() {
        let _ = std::fs::write(&ga, GITATTRIBUTES);
    }
}

/// 打开仓库；不存在则初始化（幂等）。不在此提交——根提交由 commit_all 自然产生，
/// 保证"初始版本/自动保存"等提交信息由实际调用方决定，且不会产生空提交。
fn open_or_init(vault: &str) -> Result<git2::Repository, String> {
    let repo = if Path::new(vault).join(".git").exists() {
        open_repo(vault)?
    } else {
        let root = PathBuf::from(vault);
        if !root.is_dir() {
            return Err(format!("工作区不存在: {vault}"));
        }
        ensure_ignore_files(&root);
        git2::Repository::init(&root).map_err(|e| format!("初始化仓库失败: {e}"))?
    };
    // 双保险：仓库级关闭行尾自动转换（.gitattributes 已含 `* -text`）
    if let Ok(mut cfg) = repo.config() {
        if let Err(e) = cfg.set_str("core.autocrlf", "false") {
            eprintln!("[history] 写入 core.autocrlf 失败: {e}");
        }
    }
    Ok(repo)
}

/* ---------------- 提交 ---------------- */

/// 暂存全部变更并提交。工作区无变化时返回 None（不产生空提交）。
fn commit_all(repo: &git2::Repository, message: &str) -> Result<Option<CommitInfo>, String> {
    let mut index = repo.index().map_err(|e| format!("读取索引失败: {e}"))?;
    // DEFAULT = 尊重 .gitignore（.toolbox/site/node_modules 不会进库）
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("暂存变更失败: {e}"))?;
    // .gitignore 是点文件，通配符路径不匹配，存在时显式纳入
    if repo.workdir().map(|w| w.join(".gitignore").exists()).unwrap_or(false) {
        let _ = index.add_path(Path::new(".gitignore"));
    }
    index.write().map_err(|e| format!("写入索引失败: {e}"))?;
    let tree_id = index.write_tree().map_err(|e| format!("写入树失败: {e}"))?;

    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if let Some(parent) = &head {
        if parent.tree_id() == tree_id {
            return Ok(None); // 树无变化，跳过空提交
        }
    }
    let sig =
        git2::Signature::now(AUTHOR.0, AUTHOR.1).map_err(|e| format!("创建签名失败: {e}"))?;
    let tree = repo.find_tree(tree_id).map_err(|e| format!("查找树失败: {e}"))?;
    let parents: Vec<git2::Commit> = head.iter().cloned().collect();
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
        .map_err(|e| format!("提交失败: {e}"))?;
    let commit = repo.find_commit(oid).map_err(|e| format!("查找提交失败: {e}"))?;
    commit_info(repo, &commit).map(Some)
}

/// 提交元信息（变更文件数 = 与首父提交的 diff 条数）。
fn commit_info(repo: &git2::Repository, commit: &git2::Commit) -> Result<CommitInfo, String> {
    let ct = commit.tree().map_err(|e| format!("读取树失败: {e}"))?;
    let files = match commit.parent(0) {
        Ok(parent) => {
            let pt = parent.tree().map_err(|e| format!("读取父树失败: {e}"))?;
            let diff = repo
                .diff_tree_to_tree(Some(&pt), Some(&ct), None)
                .map_err(|e| format!("计算差异失败: {e}"))?;
            diff.deltas().len()
        }
        Err(_) => {
            // 根提交：全部文件视为新增
            let diff = repo
                .diff_tree_to_tree(None, Some(&ct), None)
                .map_err(|e| format!("计算差异失败: {e}"))?;
            diff.deltas().len()
        }
    };
    let id = commit.id().to_string();
    Ok(CommitInfo {
        short: id[..7.min(id.len())].to_string(),
        hash: id,
        message: commit.message().unwrap_or("").trim().to_string(),
        time: commit.time().seconds(),
        files,
    })
}

/// 解析提交：支持完整/缩写 hash、"HEAD"。
fn resolve_commit<'r>(
    repo: &'r git2::Repository,
    hash: &str,
) -> Result<git2::Commit<'r>, String> {
    let obj = repo
        .revparse_single(hash)
        .map_err(|e| format!("找不到提交 {hash}: {e}"))?;
    obj.peel_to_commit().map_err(|e| format!("{hash} 不是提交: {e}"))
}

/* ---------------- 命令 ---------------- */

/// 初始化版本历史（幂等；已初始化则直接返回状态）。
#[tauri::command]
pub fn history_init(vault: String) -> Result<HistoryStatus, String> {
    let _lock = COMMIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = open_or_init(&vault)?;
    commit_all(&repo, "初始版本")?;
    status_impl(&vault)
}

/// 版本历史状态：是否初始化、最近提交、待提交变更数。
#[tauri::command]
pub fn history_status(vault: String) -> Result<HistoryStatus, String> {
    status_impl(&vault)
}

/// 立即提交当前全部变更（None = 无变化）。message 为空时用时间戳自动信息。
#[tauri::command]
pub fn history_commit(vault: String, message: Option<String>) -> Result<Option<CommitInfo>, String> {
    let _lock = COMMIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = open_or_init(&vault)?;
    let msg = message.unwrap_or_else(|| format!("自动保存 {}", now_str()));
    commit_all(&repo, &msg)
}

/// 提交列表（新→旧，最多 LIST_LIMIT 条）。
#[tauri::command]
pub fn history_list(vault: String) -> Result<Vec<CommitInfo>, String> {
    if !Path::new(&vault).join(".git").exists() {
        return Ok(Vec::new());
    }
    let repo = open_repo(&vault)?;
    let mut walk = repo.revwalk().map_err(|e| format!("遍历提交失败: {e}"))?;
    walk.push_head().map_err(|e| format!("无提交可遍历: {e}"))?;
    walk.set_sorting(git2::Sort::TIME).ok();
    let mut out = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| format!("遍历提交失败: {e}"))?;
        if let Ok(commit) = repo.find_commit(oid) {
            if let Ok(info) = commit_info(&repo, &commit) {
                out.push(info);
                if out.len() >= LIST_LIMIT {
                    break;
                }
            }
        }
    }
    Ok(out)
}

/// 某次提交变更的文件清单。
#[tauri::command]
pub fn history_show(vault: String, hash: String) -> Result<Vec<FileChange>, String> {
    let repo = open_repo(&vault)?;
    let commit = resolve_commit(&repo, &hash)?;
    let ct = commit.tree().map_err(|e| format!("读取树失败: {e}"))?;
    let diff = match commit.parent(0) {
        Ok(parent) => {
            let pt = parent.tree().map_err(|e| format!("读取父树失败: {e}"))?;
            repo.diff_tree_to_tree(Some(&pt), Some(&ct), None)
                .map_err(|e| format!("计算差异失败: {e}"))?
        }
        Err(_) => repo
            .diff_tree_to_tree(None, Some(&ct), None)
            .map_err(|e| format!("计算差异失败: {e}"))?,
    };
    let mut out = Vec::new();
    for delta in diff.deltas() {
        let status = match delta.status() {
            git2::Delta::Added => "A",
            git2::Delta::Deleted => "D",
            git2::Delta::Renamed => "R",
            _ => "M",
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(FileChange {
            path,
            status: status.to_string(),
        });
    }
    Ok(out)
}

/// 回滚到指定版本：先提交当前未提交变更（不丢数据），再 hard reset。
/// 未跟踪的新文件保留（不做 clean，避免误删用户数据）。
#[tauri::command]
pub fn history_rollback(vault: String, hash: String) -> Result<(), String> {
    let _lock = COMMIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if !Path::new(&vault).join(".git").exists() {
        return Err("版本历史尚未初始化".to_string());
    }
    let repo = open_repo(&vault)?;
    commit_all(&repo, &format!("回滚前保存 {}", now_str()))?;
    let commit = resolve_commit(&repo, &hash)?;
    repo.reset(commit.as_object(), git2::ResetType::Hard, None)
        .map_err(|e| format!("回滚失败: {e}"))?;
    Ok(())
}

fn status_impl(vault: &str) -> Result<HistoryStatus, String> {
    if !Path::new(vault).join(".git").exists() {
        return Ok(HistoryStatus {
            initialized: false,
            last_commit: None,
            pending: 0,
        });
    }
    let repo = open_repo(vault)?;
    let last_commit = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| commit_info(&repo, &c).ok());
    let pending = {
        let mut opts = git2::StatusOptions::new();
        opts.include_untracked(true);
        repo.statuses(Some(&mut opts))
            .map(|s| s.iter().len())
            .unwrap_or(0)
    };
    Ok(HistoryStatus {
        initialized: true,
        last_commit,
        pending,
    })
}

/* ---------------- 自动提交（防抖） ---------------- */

/// 标记 vault 有未提交变更（编辑类命令成功后调用）。
pub fn mark_dirty(vault: &str) {
    let state = dirty_state();
    let mut map = match state.map.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    map.insert(vault.to_string(), Instant::now());
    drop(map);
    state.cv.notify_all();
}

/// 立即提交该 vault 的全部待提交变更（防抖器/手动/退出冲刷共用）。
fn commit_vault(vault: &str) -> Result<Option<CommitInfo>, String> {
    let _lock = COMMIT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = open_or_init(vault)?;
    commit_all(&repo, &format!("自动保存 {}", now_str()))
}

/// 后台自动提交线程：监听 mark_dirty，停止编辑 DEBOUNCE 后提交一次。
pub fn spawn_auto_committer() {
    std::thread::spawn(|| loop {
        let state = dirty_state();
        // 找出已到期的 vault，或下一个最早到期时间
        let (ready, wait_for): (Option<String>, Option<Duration>) = {
            let map = state.map.lock().unwrap();
            let now = Instant::now();
            let mut ready = None;
            let mut soonest: Option<(String, Instant)> = None;
            for (v, t) in map.iter() {
                let deadline = *t + DEBOUNCE;
                if deadline <= now {
                    ready = Some(v.clone());
                    break;
                }
                match &soonest {
                    Some((_, sd)) if *sd <= deadline => {}
                    _ => soonest = Some((v.clone(), deadline)),
                }
            }
            match ready {
                Some(v) => (Some(v), None),
                None => (None, soonest.map(|(_, d)| d - now)),
            }
        };
        if let Some(vault) = ready {
            {
                let mut map = state.map.lock().unwrap();
                map.remove(&vault);
            }
            if let Err(e) = commit_vault(&vault) {
                eprintln!("[history] 自动提交失败 {vault}: {e}");
            }
        } else {
            let map = state.map.lock().unwrap();
            match wait_for {
                Some(d) => {
                    let _guard = state.cv.wait_timeout(map, d);
                }
                None => {
                    let _guard = state.cv.wait(map);
                }
            }
        }
    });
}

/// 退出前冲刷：同步提交所有仍有待提交变更的 vault（托盘"退出"时调用）。
pub fn flush_pending() {
    let vaults: Vec<String> = {
        let state = dirty_state();
        let map = state.map.lock().unwrap();
        map.keys().cloned().collect()
    };
    for v in vaults {
        if let Err(e) = commit_vault(&v) {
            eprintln!("[history] 退出前提交失败 {v}: {e}");
        }
    }
}

/// 本地时间字符串（Windows GetLocalTime；其他平台退化为 epoch）。
fn now_str() -> String {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct LocalTime {
            w_year: u16,
            w_month: u16,
            w_day_of_week: u16,
            w_day: u16,
            w_hour: u16,
            w_minute: u16,
            w_second: u16,
            w_ms: u16,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetLocalTime(lp: *mut LocalTime);
        }
        let mut t = LocalTime {
            w_year: 0,
            w_month: 0,
            w_day_of_week: 0,
            w_day: 0,
            w_hour: 0,
            w_minute: 0,
            w_second: 0,
            w_ms: 0,
        };
        unsafe { GetLocalTime(&mut t) };
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            t.w_year, t.w_month, t.w_day, t.w_hour, t.w_minute, t.w_second
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("epoch-{secs}")
    }
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_vault(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("toolbox-history-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::create_dir_all(dir.join(".toolbox")).unwrap();
        fs::write(dir.join("notes/a.md"), "# A").unwrap();
        fs::write(dir.join(".toolbox/search-fts.sqlite"), "binary").unwrap();
        dir
    }

    fn commit_msg(vault: &str, msg: &str) -> Option<CommitInfo> {
        let repo = open_or_init(vault).unwrap();
        commit_all(&repo, msg).unwrap()
    }

    #[test]
    fn init_creates_repo_and_root_commit() {
        let v = temp_vault("init");
        let vs = v.to_str().unwrap();
        let first = commit_msg(vs, "初始版本").unwrap();
        assert!(v.join(".git").is_dir(), ".git 应存在");
        assert!(v.join(".gitignore").exists(), ".gitignore 应自动创建");
        assert!(v.join(".gitattributes").exists(), ".gitattributes 应自动创建");
        assert_eq!(first.message, "初始版本");
        let repo = open_repo(vs).unwrap();
        let mut cfg = repo.config().unwrap();
        let cfg = cfg.snapshot().unwrap();
        assert_eq!(
            cfg.get_str("core.autocrlf").unwrap_or(""),
            "false",
            "应显式关闭行尾转换（字节保真）"
        );
        let head = repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        assert_eq!(commit.message().unwrap().trim(), "初始版本");
        assert!(first.files >= 1, "根提交应包含笔记文件, got {}", first.files);
        // .toolbox 被忽略：SQLite 索引不应进库
        let tree = commit.tree().unwrap();
        let mut names = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |_, entry| {
            names.push(entry.name().unwrap_or("").to_string());
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        assert!(
            !names.iter().any(|n| n.contains(".toolbox")),
            ".toolbox 不应被版本化: {names:?}"
        );
        let _ = fs::remove_dir_all(&v);
    }

    #[test]
    fn commit_captures_changes_and_skips_empty() {
        let v = temp_vault("commit");
        let vs = v.to_str().unwrap();
        let first = commit_msg(vs, "初始版本").unwrap();
        fs::write(v.join("notes/a.md"), "# A changed").unwrap();
        fs::write(v.join("notes/b.md"), "# B").unwrap();
        let second = commit_msg(vs, "变更");
        assert!(second.is_some(), "修改后应产生新提交");
        let second = second.unwrap();
        assert_ne!(first.hash, second.hash);
        let list = history_list(vs.to_string()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].hash, second.hash, "最新提交应在前");
        // 无变更时不应产生空提交
        assert!(commit_msg(vs, "空提交").is_none());
        let _ = fs::remove_dir_all(&v);
    }

    #[test]
    fn show_lists_files_with_status() {
        let v = temp_vault("show");
        let vs = v.to_str().unwrap();
        commit_msg(vs, "初始");
        fs::write(v.join("notes/b.md"), "# B").unwrap();
        let c = commit_msg(vs, "加 b").unwrap();
        fs::remove_file(v.join("notes/a.md")).unwrap();
        let c2 = commit_msg(vs, "删 a").unwrap();
        let files = history_show(vs.to_string(), c2.short.clone()).unwrap();
        assert!(
            files.iter().any(|f| f.path == "notes/a.md" && f.status == "D"),
            "删除应标 D: {files:?}"
        );
        let files2 = history_show(vs.to_string(), c.short.clone()).unwrap();
        assert!(
            files2.iter().any(|f| f.path == "notes/b.md" && f.status == "A"),
            "新增应标 A: {files2:?}"
        );
        let _ = fs::remove_dir_all(&v);
    }

    #[test]
    fn rollback_restores_files_and_keeps_untracked() {
        let v = temp_vault("rollback");
        let vs = v.to_str().unwrap();
        commit_msg(vs, "初始");
        fs::write(v.join("notes/a.md"), "版本 2").unwrap();
        let mid = commit_msg(vs, "v2").unwrap();
        fs::write(v.join("notes/a.md"), "版本 3").unwrap();
        commit_msg(vs, "v3");
        history_rollback(vs.to_string(), mid.short.clone()).unwrap();
        assert_eq!(
            fs::read_to_string(v.join("notes/a.md")).unwrap(),
            "版本 2",
            "回滚应恢复文件内容"
        );
        // 未跟踪的新文件在回滚后保留
        fs::write(v.join("notes/untracked.md"), "新文件").unwrap();
        history_rollback(vs.to_string(), "HEAD".to_string()).unwrap();
        assert!(v.join("notes/untracked.md").exists(), "未跟踪文件不应被删除");
        let _ = fs::remove_dir_all(&v);
    }

    #[test]
    fn rollback_preserves_line_endings() {
        // 字节保真：LF 结尾的文件在提交 + 回滚后必须保持 LF
        // （libgit2 在 Windows 默认 checkout 会转 CRLF，.gitattributes `-text` 必须生效）
        let v = temp_vault("eol");
        let vs = v.to_str().unwrap();
        commit_msg(vs, "初始");
        fs::write(v.join("notes/a.md"), "行一\n行二\n").unwrap();
        let c = commit_msg(vs, "LF").unwrap();
        fs::write(v.join("notes/a.md"), "行一\r\n行二\r\n").unwrap();
        commit_msg(vs, "CRLF");
        history_rollback(vs.to_string(), c.short.clone()).unwrap();
        let bytes = fs::read(v.join("notes/a.md")).unwrap();
        assert_eq!(
            bytes,
            b"\xe8\xa1\x8c\xe4\xb8\x80\n\xe8\xa1\x8c\xe4\xba\x8c\n",
            "回滚后应保持 LF 行尾（字节保真）: {bytes:?}"
        );
        let _ = fs::remove_dir_all(&v);
    }

    #[test]
    fn dirty_state_tracks_vaults() {
        // 进程级单例：mark_dirty 后应出现在待提交状态里
        mark_dirty("v1");
        let state = dirty_state();
        assert!(state.map.lock().unwrap().contains_key("v1"));
        state.map.lock().unwrap().clear();
    }
}
