//! 自动备份（Backlog）：vault → `.toolbox/backups/<时间戳>/`，保留最近 N 份。
//!
//! - 备份 = 递归复制（排除备份目录自身与 site/ 生成物、临时文件）
//! - 配置存 `%APPDATA%/com.toolbox.desktop/backup.json`（与 ai.json 同级）
//! - 后台任务每 60s 检查一次：启用且距上次备份超过间隔则执行

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// 备份根目录（相对 vault）
const BACKUP_DIR: &str = ".toolbox/backups";
/// 默认备份间隔（分钟）
const DEFAULT_INTERVAL_MIN: u64 = 30;
/// 默认保留份数
const DEFAULT_KEEP: usize = 10;
/// 后台检查周期
const CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// 备份全局互斥：手动"立即备份"与后台自动备份并发时，
/// unique_backup_dir 的"存在检查后创建"是 TOCTOU，两份备份会混写进
/// 同一目录，prune 也会打断复制。锁在 `backup_now` 内持有（复制 + prune）。
static BACKUP_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfig {
    pub enabled: bool,
    pub interval_minutes: u64,
    pub keep: usize,
    /// 上次成功备份时间（unix 秒）
    pub last_backup_at: Option<i64>,
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_minutes: DEFAULT_INTERVAL_MIN,
            keep: DEFAULT_KEEP,
            last_backup_at: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    /// 本次备份目录绝对路径
    pub path: String,
    pub size_bytes: u64,
    pub file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    /// unix 秒（从目录名解析）
    pub timestamp: i64,
    pub size_bytes: u64,
}

/* ---------------- 配置读写 ---------------- */

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("backup.json"))
}

fn load_config(app: &tauri::AppHandle) -> BackupConfig {
    let Ok(p) = config_path(app) else {
        return BackupConfig::default();
    };
    if !p.exists() {
        return BackupConfig::default();
    }
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<BackupConfig>(&raw).ok())
        .unwrap_or_default()
}

fn save_config(app: &tauri::AppHandle, cfg: &BackupConfig) -> Result<(), String> {
    let p = config_path(app)?;
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| format!("保存备份配置失败: {e}"))
}

/* ---------------- 备份实现 ---------------- */

fn backups_root(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(BACKUP_DIR)
}

/// 排除规则：
/// - `site`：仅排除 vault **根级**的博客生成物（可重建）；
///   项目内同名目录（projects/x/site/）是用户数据，必须备份
/// - `.git`：仅排除 vault 根级的 git 残留（旧版版本历史遗留，独立图层不重复备份）
/// - 备份目录自身防递归；FTS 搜索索引及其 WAL/SHM 派生文件（派生数据，可从笔记重建）
/// - 临时文件
fn is_skipped(parent: &Path, name: &str, at_root: bool) -> bool {
    if at_root && (name == "site" || name == ".git") {
        return true;
    }
    if parent.file_name().map(|n| n == ".toolbox").unwrap_or(false) {
        if name == "backups" || name.starts_with("search-fts.sqlite") {
            return true;
        }
    }
    name.ends_with(".tmp") || name.ends_with('~') || name == "desktop.ini"
}

/// 递归复制目录，返回（字节数, 文件数）。
/// `at_root` 标记当前目录是否为备份根（vault 本身）：只有根级 `site` 被排除。
fn copy_dir_all(src: &Path, dst: &Path, at_root: bool) -> Result<(u64, usize), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建备份目录失败 {dst:?}: {e}"))?;
    let mut total = 0u64;
    let mut count = 0usize;
    let Ok(read) = std::fs::read_dir(src) else {
        return Ok((total, count));
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_skipped(src, &name, at_root) {
            continue;
        }
        let s = entry.path();
        let d = dst.join(&name);
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let (sz, c) = copy_dir_all(&s, &d, false)?;
            total += sz;
            count += c;
        } else {
            let sz = std::fs::copy(&s, &d)
                .map_err(|e| format!("复制 {name} 失败（{s:?} → {d:?}）: {e}"))?;
            total += sz;
            count += 1;
        }
    }
    Ok((total, count))
}

/// 目录名去重：`backup-<ts>` 已存在则追加 `-2`、`-3`…
fn unique_backup_dir(backups: &Path, ts: i64) -> PathBuf {
    let mut dir = backups.join(format!("backup-{ts}"));
    let mut i = 2;
    while dir.exists() {
        dir = backups.join(format!("backup-{ts}-{i}"));
        i += 1;
    }
    dir
}

/// 清理最旧的备份，只保留最近 `keep` 份。
fn prune(backups: &Path, keep: usize) {
    let Ok(read) = std::fs::read_dir(backups) else {
        return;
    };
    let mut dirs: Vec<_> = read
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("backup-") && e.file_type().map(|t| t.is_dir()).unwrap_or(false)
        })
        .collect();
    dirs.sort_by_key(|e| e.file_name());
    let mut excess = dirs.len().saturating_sub(keep);
    for d in dirs {
        if excess == 0 {
            break;
        }
        let _ = std::fs::remove_dir_all(d.path());
        excess -= 1;
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(read) = std::fs::read_dir(dir) {
        for e in read.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                total += dir_size(&e.path());
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/* ---------------- 命令 ---------------- */

/// 立即备份（手动或后台任务调用）。全局锁防止手动/自动并发。
pub fn backup_now(app: &tauri::AppHandle, vault: &str) -> Result<BackupInfo, String> {
    // 整个复制 + prune 持锁：并发备份会混写同一目录 / 互相打断 prune
    let _guard = BACKUP_LOCK.lock().map_err(|_| "备份正在进行中".to_string())?;
    let root = PathBuf::from(vault);
    if !root.is_dir() {
        return Err(format!("工作区不存在: {vault}"));
    }
    let backups = backups_root(vault);
    std::fs::create_dir_all(&backups).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let ts = unix_now();
    let dir = unique_backup_dir(&backups, ts);
    let (size, count) = copy_dir_all(&root, &dir, true)?;
    let keep = load_config(app).keep.max(1);
    prune(&backups, keep);
    // 手动/自动备份成功后都更新计时，避免手动备份后自动备份仍按旧计时触发
    let mut cfg = load_config(app);
    cfg.last_backup_at = Some(unix_now());
    let _ = save_config(app, &cfg);
    Ok(BackupInfo {
        path: dir.to_string_lossy().to_string(),
        size_bytes: size,
        file_count: count,
    })
}

/// 立即备份命令：async + spawn_blocking，大 vault 复制不再冻结 UI 主线程。
#[tauri::command]
pub async fn backup_now_cmd(app: tauri::AppHandle, vault: String) -> Result<BackupInfo, String> {
    tauri::async_runtime::spawn_blocking(move || backup_now(&app, &vault))
        .await
        .map_err(|e| format!("备份任务失败: {e}"))?
}

#[tauri::command]
pub fn backup_config_get(app: tauri::AppHandle) -> Result<BackupConfig, String> {
    Ok(load_config(&app))
}

#[tauri::command]
pub fn backup_config_set(app: tauri::AppHandle, config: BackupConfig) -> Result<(), String> {
    let mut cfg = config;
    // 防御：非法值回退默认
    if cfg.interval_minutes == 0 {
        cfg.interval_minutes = DEFAULT_INTERVAL_MIN;
    }
    if cfg.keep == 0 {
        cfg.keep = DEFAULT_KEEP;
    }
    save_config(&app, &cfg)
}

#[tauri::command]
pub fn backup_list(vault: String) -> Result<Vec<BackupEntry>, String> {
    let backups = backups_root(&vault);
    let Ok(read) = std::fs::read_dir(&backups) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("backup-") || !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let ts = name
            .strip_prefix("backup-")
            .and_then(|s| s.split('-').next())
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        out.push(BackupEntry {
            name,
            timestamp: ts,
            size_bytes: dir_size(&e.path()),
        });
    }
    out.sort_by_key(|b| b.timestamp);
    Ok(out)
}

/* ---------------- 后台定时任务 ---------------- */

/// 启动后台自动备份：每 60s 检查配置；启用且到期则备份当前工作区。
/// 备份为同步文件复制，放独立线程避免阻塞主线程/异步运行时。
pub fn spawn_auto(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(CHECK_INTERVAL);
        let cfg = load_config(&app);
        if !cfg.enabled {
            continue;
        }
        let interval = (cfg.interval_minutes.max(1) as i64) * 60;
        let last = cfg.last_backup_at.unwrap_or(0);
        let now = unix_now();
        if now - last < interval {
            continue;
        }
        // 没有配置工作区则跳过（应用启动时可能尚未选择）
        let Ok(Some(vault)) = crate::core::vault::read_vault_path(&app) else {
            continue;
        };
        if backup_now(&app, &vault).is_ok() {
            let mut c = load_config(&app);
            c.last_backup_at = Some(now);
            let _ = save_config(&app, &c);
        }
    });
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("toolbox-backup-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn copy_and_exclude() {
        let v = tmp_vault("copy");
        std::fs::create_dir_all(v.join("notes/子")).unwrap();
        std::fs::create_dir_all(v.join("site")).unwrap();
        std::fs::create_dir_all(v.join("projects/foo/site")).unwrap();
        std::fs::create_dir_all(v.join(".toolbox")).unwrap();
        std::fs::write(v.join("notes/a.md"), "# a").unwrap();
        std::fs::write(v.join("notes/子/b.md"), "# b").unwrap();
        std::fs::write(v.join("site/index.html"), "<html>").unwrap(); // 根级 site 应排除
        std::fs::write(v.join("projects/foo/site/data.txt"), "x").unwrap(); // 项目内 site 应保留
        std::fs::write(v.join(".toolbox/search-fts.sqlite-wal"), "w").unwrap(); // 派生文件应排除
        std::fs::write(v.join("notes/x.tmp"), "tmp").unwrap(); // 应排除
        let dst = v.join(".toolbox/backups/b1");
        let (size, count) = copy_dir_all(&v, &dst, true).unwrap();
        assert_eq!(count, 3, "复制 2 个 md + 项目内 site 文件，排除根 site/tmp/WAL");
        assert!(size > 0);
        assert!(dst.join("notes/a.md").exists());
        assert!(!dst.join("site").exists(), "根级 site 应排除");
        assert!(dst.join("projects/foo/site/data.txt").exists(), "项目内 site 应保留");
        assert!(!dst.join(".toolbox/search-fts.sqlite-wal").exists(), "WAL 派生文件应排除");
        assert!(!dst.join("notes/x.tmp").exists());
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn prune_keeps_newest() {
        let v = tmp_vault("prune");
        let backups = v.join(".toolbox/backups");
        std::fs::create_dir_all(&backups).unwrap();
        for i in 1..=5 {
            std::fs::create_dir_all(backups.join(format!("backup-{i}"))).unwrap();
        }
        prune(&backups, 3);
        let left: Vec<_> = std::fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left.len(), 3, "保留最近 3 份: {left:?}");
        assert!(left.contains(&"backup-3".to_string()));
        assert!(left.contains(&"backup-5".to_string()));
        assert!(!left.contains(&"backup-1".to_string()));
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn unique_dir_suffix() {
        let backups = std::env::temp_dir().join(format!("toolbox-backup-uniq-{}", std::process::id()));
        std::fs::create_dir_all(&backups).unwrap();
        std::fs::create_dir_all(backups.join("backup-100")).unwrap();
        let d = unique_backup_dir(&backups, 100);
        assert_eq!(d.file_name().unwrap().to_string_lossy(), "backup-100-2");
        std::fs::remove_dir_all(&backups).ok();
    }

    #[test]
    fn skip_rules() {
        // 根级 site 排除，项目内 site 保留
        assert!(is_skipped(Path::new("vault"), "site", true));
        assert!(!is_skipped(Path::new("vault/projects/foo"), "site", false), "项目内 site 应备份");
        assert!(is_skipped(Path::new("vault"), ".git", true), "根级 .git 不进备份");
        assert!(!is_skipped(Path::new("vault/projects/foo"), ".git", false), "项目内 .git 是用户数据");
        assert!(is_skipped(Path::new("vault/.toolbox"), "backups", false));
        assert!(is_skipped(Path::new("vault/.toolbox"), "search-fts.sqlite", false));
        assert!(is_skipped(Path::new("vault/.toolbox"), "search-fts.sqlite-wal", false), "WAL 派生文件不进备份");
        assert!(!is_skipped(Path::new("vault"), ".toolbox", true), ".toolbox 本身要复制（含 plugins.json）");
        assert!(!is_skipped(Path::new("vault"), "search-fts.sqlite", true), "根目录下的同名文件不该被误排除");
        assert!(is_skipped(Path::new("vault"), "a.tmp", true));
        assert!(!is_skipped(Path::new("vault"), "notes", true));
    }
}
