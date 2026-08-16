//! 自动备份核心插件（cdylib，id: core-backup）。
//!
//! 由宿主 core/backup.rs 移植：vault 快照复制（排除 site/.git/备份自身/索引）+
//! %APPDATA% 配置 json + 全局插件目录存档；恢复 = 覆盖合并（恢复前自动保存现场）。
//! 配置存 config_dir/backup.json；后台自动备份线程由插件启动（进程内单例）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 备份根目录（相对 vault）
const BACKUP_DIR: &str = ".toolbox/backups";
/// 配置存档子目录（备份根内）
const CONFIG_ARCHIVE: &str = "_config";
/// 插件存档子目录（备份根内）
const PLUGINS_ARCHIVE: &str = "_plugins";
/// 默认备份间隔（分钟）
const DEFAULT_INTERVAL_MIN: u64 = 30;
/// 默认保留份数
const DEFAULT_KEEP: usize = 10;
/// 后台检查周期
const CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// 备份全局互斥：手动"立即备份"与后台自动备份并发时防混写。
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
    pub path: String,
    pub size_bytes: u64,
    pub file_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub name: String,
    pub timestamp: i64,
    pub size_bytes: u64,
    pub has_config: bool,
    pub has_plugins: bool,
}

pub struct BackupState {
    config_dir: String,
}

fn state_from_cfg(cfg: &Value) -> Result<BackupState, String> {
    let config_dir = cfg
        .get("config_dir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if config_dir.is_empty() {
        return Err("缺少 config_dir 配置".to_string());
    }
    // 后台自动备份线程（进程内单例，随插件加载启动）
    spawn_auto(config_dir.clone());
    Ok(BackupState { config_dir })
}

/* ---------------- 配置读写 ---------------- */

fn config_path(config_dir: &str) -> PathBuf {
    PathBuf::from(config_dir).join("backup.json")
}

fn load_config(config_dir: &str) -> BackupConfig {
    let p = config_path(config_dir);
    if !p.exists() {
        return BackupConfig::default();
    }
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<BackupConfig>(&raw).ok())
        .unwrap_or_default()
}

fn save_config(config_dir: &str, cfg: &BackupConfig) -> Result<(), String> {
    let p = config_path(config_dir);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| format!("保存备份配置失败: {e}"))
}

/// 当前工作区：从配置目录的 vault.json 读（自动备份线程用）。
fn read_current_vault(config_dir: &str) -> Option<String> {
    let raw = std::fs::read_to_string(PathBuf::from(config_dir).join("vault.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("path").and_then(|p| p.as_str()).map(String::from)
}

/* ---------------- 备份实现 ---------------- */

fn backups_root(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(BACKUP_DIR)
}

/// 排除规则：根级 site/.git；备份根内的 _config/_plugins（存档不随 vault 恢复）；
/// .toolbox 下的 backups 与 FTS 派生文件；临时文件。
fn is_skipped(parent: &Path, name: &str, at_root: bool) -> bool {
    if at_root && (name == "site" || name == ".git") {
        return true;
    }
    if at_root && (name == CONFIG_ARCHIVE || name == PLUGINS_ARCHIVE) {
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

/// 复制应用配置存档：config_dir 顶层所有 *.json。
fn copy_config_archive(src: &Path, dst: &Path) -> Result<(u64, usize), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建配置存档失败: {e}"))?;
    let mut total = 0u64;
    let mut count = 0usize;
    let Ok(read) = std::fs::read_dir(src) else {
        return Ok((total, count));
    };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let sz = std::fs::copy(e.path(), dst.join(&name))
            .map_err(|err| format!("复制配置 {name} 失败: {err}"))?;
        total += sz;
        count += 1;
    }
    Ok((total, count))
}

/// 复制全局插件目录存档（排除核心插件 _core）。
fn copy_plugins_archive(src: &Path, dst: &Path) -> Result<(u64, usize), String> {
    if !src.is_dir() {
        return Ok((0, 0));
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("创建插件存档失败: {e}"))?;
    let mut total = 0u64;
    let mut count = 0usize;
    let Ok(read) = std::fs::read_dir(src) else {
        return Ok((total, count));
    };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == "_core" {
            continue;
        }
        let s = e.path();
        let d = dst.join(&name);
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let (sz, c) = copy_dir_all(&s, &d, false)?;
            total += sz;
            count += c;
        } else {
            let sz = std::fs::copy(&s, &d)
                .map_err(|err| format!("复制插件 {name} 失败: {err}"))?;
            total += sz;
            count += 1;
        }
    }
    Ok((total, count))
}

/* ---------------- 命令 ---------------- */

/// 立即备份。`keep=0` 表示不清理（恢复流程为现场备份跳过 prune）。
pub fn backup_now(config_dir: &str, vault: &str, keep: usize) -> Result<BackupInfo, String> {
    let _guard = BACKUP_LOCK.lock().map_err(|_| "备份正在进行中".to_string())?;
    backup_now_impl(config_dir, vault, keep)
}

fn backup_now_impl(config_dir: &str, vault: &str, keep: usize) -> Result<BackupInfo, String> {
    let root = PathBuf::from(vault);
    if !root.is_dir() {
        return Err(format!("工作区不存在: {vault}"));
    }
    let backups = backups_root(vault);
    std::fs::create_dir_all(&backups).map_err(|e| format!("创建备份目录失败: {e}"))?;
    let ts = unix_now();
    let dir = unique_backup_dir(&backups, ts);
    let (mut size, mut count) = copy_dir_all(&root, &dir, true)?;

    // 存档：应用配置（%APPDATA% 下 json） + 全局插件（排除核心 _core）
    let cfg_dir = PathBuf::from(config_dir);
    if let Ok((sz, c)) = copy_config_archive(&cfg_dir, &dir.join(CONFIG_ARCHIVE)) {
        size += sz;
        count += c;
    }
    if let Ok((sz, c)) = copy_plugins_archive(&cfg_dir.join("plugins"), &dir.join(PLUGINS_ARCHIVE))
    {
        size += sz;
        count += c;
    }

    if keep > 0 {
        prune(&backups, keep);
    }
    Ok(BackupInfo {
        path: dir.to_string_lossy().to_string(),
        size_bytes: size,
        file_count: count,
    })
}

/// 立即备份命令入口（更新计时后返回）。
fn backup_now_cmd(config_dir: &str, vault: &str) -> Result<BackupInfo, String> {
    let keep = load_config(config_dir).keep.max(1);
    let info = backup_now(config_dir, vault, keep)?;
    let mut cfg = load_config(config_dir);
    cfg.last_backup_at = Some(unix_now());
    let _ = save_config(config_dir, &cfg);
    Ok(info)
}

pub fn backup_config_get(config_dir: &str) -> BackupConfig {
    load_config(config_dir)
}

pub fn backup_config_set(config_dir: &str, config: BackupConfig) -> Result<(), String> {
    let mut cfg = config;
    if cfg.interval_minutes == 0 {
        cfg.interval_minutes = DEFAULT_INTERVAL_MIN;
    }
    if cfg.keep == 0 {
        cfg.keep = DEFAULT_KEEP;
    }
    save_config(config_dir, &cfg)
}

pub fn backup_list(vault: &str) -> Vec<BackupEntry> {
    let backups = backups_root(vault);
    let Ok(read) = std::fs::read_dir(&backups) else {
        return Vec::new();
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
            has_config: e.path().join(CONFIG_ARCHIVE).is_dir(),
            has_plugins: e.path().join(PLUGINS_ARCHIVE).is_dir(),
        });
    }
    out.sort_by_key(|b| b.timestamp);
    out
}

/// 恢复到备份点：先自动保存当前现场（可反悔），再把备份内容复制回 vault。
pub fn restore_backup(config_dir: &str, vault: &str, name: &str) -> Result<BackupInfo, String> {
    let _guard = BACKUP_LOCK.lock().map_err(|_| "备份正在进行中".to_string())?;
    if name.is_empty()
        || !name.starts_with("backup-")
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
    {
        return Err("非法备份名称".to_string());
    }
    let root = PathBuf::from(vault);
    if !root.is_dir() {
        return Err(format!("工作区不存在: {vault}"));
    }
    let src = backups_root(vault).join(name);
    if !src.is_dir() {
        return Err(format!("备份不存在: {name}"));
    }
    // 恢复前自动保存当前状态（keep=0 跳过 prune 保护目标备份点）
    backup_now_impl(config_dir, vault, 0)?;
    let (size, count) = copy_dir_all(&src, &root, true)?;
    let mut cfg = load_config(config_dir);
    cfg.last_backup_at = Some(unix_now());
    let _ = save_config(config_dir, &cfg);
    Ok(BackupInfo {
        path: src.to_string_lossy().to_string(),
        size_bytes: size,
        file_count: count,
    })
}

/* ---------------- 后台自动备份 ---------------- */

/// 启动后台自动备份线程（进程内单例，仅一次）：每 60s 检查配置；
/// 启用且到期则备份当前工作区。
fn spawn_auto(config_dir: String) {
    static STARTED: OnceLock<()> = OnceLock::new();
    let _ = STARTED.get_or_init(|| {
        std::thread::spawn(move || loop {
            std::thread::sleep(CHECK_INTERVAL);
            let cfg = load_config(&config_dir);
            if !cfg.enabled {
                continue;
            }
            let interval = (cfg.interval_minutes.max(1) as i64) * 60;
            let last = cfg.last_backup_at.unwrap_or(0);
            let now = unix_now();
            if now - last < interval {
                continue;
            }
            let Some(vault) = read_current_vault(&config_dir) else {
                continue;
            };
            if backup_now(&config_dir, &vault, cfg.keep.max(1)).is_ok() {
                let mut c = load_config(&config_dir);
                c.last_backup_at = Some(unix_now());
                let _ = save_config(&config_dir, &c);
            }
        });
    });
}

/* ---------------- 命令分发 ---------------- */

fn call(
    state: &mut BackupState,
    _host: tb_sdk::TbHostApi,
    _ctx: *mut std::ffi::c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let config_dir = state.config_dir.clone();
    let s = |k: &str| params.get(k).and_then(|v| v.as_str()).map(String::from);
    match method {
        "backup.now" => {
            let vault = s("vault").ok_or("缺少 vault")?;
            let info = backup_now_cmd(&config_dir, &vault)?;
            serde_json::to_value(info).map_err(|e| e.to_string())
        }
        "backup.configGet" => {
            let cfg = backup_config_get(&config_dir);
            serde_json::to_value(cfg).map_err(|e| e.to_string())
        }
        "backup.configSet" => {
            let cfg: BackupConfig = serde_json::from_value(
                params.get("config").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| format!("配置非法: {e}"))?;
            backup_config_set(&config_dir, cfg)?;
            Ok(Value::Null)
        }
        "backup.list" => {
            let vault = s("vault").ok_or("缺少 vault")?;
            let list = backup_list(&vault);
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "backup.restore" => {
            let vault = s("vault").ok_or("缺少 vault")?;
            let name = s("name").ok_or("缺少 name")?;
            let info = restore_backup(&config_dir, &vault, &name)?;
            serde_json::to_value(info).map_err(|e| e.to_string())
        }
        _ => Err(format!("未知命令: {method}")),
    }
}

tb_sdk::tb_plugin!(BackupState, state_from_cfg, call);

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb-backup-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn copy_and_exclude() {
        let v = tmp_dir("copy");
        std::fs::create_dir_all(v.join("notes/子")).unwrap();
        std::fs::create_dir_all(v.join("site")).unwrap();
        std::fs::create_dir_all(v.join("projects/foo/site")).unwrap();
        std::fs::create_dir_all(v.join(".toolbox")).unwrap();
        std::fs::write(v.join("notes/a.md"), "# a").unwrap();
        std::fs::write(v.join("notes/子/b.md"), "# b").unwrap();
        std::fs::write(v.join("site/index.html"), "<html>").unwrap();
        std::fs::write(v.join("projects/foo/site/data.txt"), "x").unwrap();
        std::fs::write(v.join(".toolbox/search-fts.sqlite-wal"), "w").unwrap();
        std::fs::write(v.join("notes/x.tmp"), "tmp").unwrap();
        let dst = v.join(".toolbox/backups/b1");
        let (size, count) = copy_dir_all(&v, &dst, true).unwrap();
        assert_eq!(count, 3, "复制 2 个 md + 项目内 site 文件，排除根 site/tmp/WAL");
        assert!(size > 0);
        assert!(dst.join("notes/a.md").exists());
        assert!(!dst.join("site").exists());
        assert!(dst.join("projects/foo/site/data.txt").exists());
        assert!(!dst.join(".toolbox/search-fts.sqlite-wal").exists());
        assert!(!dst.join("notes/x.tmp").exists());
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn prune_keeps_newest() {
        let v = tmp_dir("prune");
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
        assert!(!left.contains(&"backup-1".to_string()));
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn restore_restores_vault_and_skips_archives() {
        let v = tmp_dir("restore");
        let vault = v.to_str().unwrap();
        let config_dir = tmp_dir("cfg");
        let backups = v.join(".toolbox/backups");
        std::fs::create_dir_all(backups.join("backup-100/notes")).unwrap();
        std::fs::write(backups.join("backup-100/notes/a.md"), "# 恢复版").unwrap();
        std::fs::create_dir_all(backups.join("backup-100/_config")).unwrap();
        std::fs::write(backups.join("backup-100/_config/vault.json"), "{}").unwrap();
        std::fs::create_dir_all(backups.join("backup-100/_plugins/demo")).unwrap();
        std::fs::create_dir_all(v.join("notes")).unwrap();
        std::fs::write(v.join("notes/a.md"), "# v2").unwrap();
        std::fs::write(v.join("notes/extra.md"), "# extra").unwrap();

        restore_backup(config_dir.to_str().unwrap(), vault, "backup-100").unwrap();

        assert_eq!(
            std::fs::read_to_string(v.join("notes/a.md")).unwrap(),
            "# 恢复版"
        );
        assert!(v.join("notes/extra.md").exists(), "覆盖合并保留新增");
        assert!(!v.join("_config").exists(), "存档不随恢复覆盖");
        assert!(!v.join("_plugins").exists());
        let names: Vec<_> = std::fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            names.iter().any(|n| n.starts_with("backup-") && n != "backup-100"),
            "恢复前应保存现场: {names:?}"
        );
        assert!(restore_backup(config_dir.to_str().unwrap(), vault, "../evil").is_err());
        std::fs::remove_dir_all(&v).ok();
        std::fs::remove_dir_all(&config_dir).ok();
    }
}
