//! 自动备份（宿主内嵌）：vault 快照复制（排除 site/.git/备份自身/索引）+
//! %APPDATA% 配置 json + 全局插件目录存档；恢复 = 覆盖合并（恢复前自动保存现场）。
//!
//! 由核心插件 core-backup 迁回本体（备份是数据安全兜底，不作为可装卸插件）。
//! 配置存 config_dir/backup.json；后台自动备份线程由宿主 setup 启动（进程内单例）。

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
    // 原子写：临时文件 + rename（直接 fs::write 崩溃会留下损坏 JSON，配置丢失）
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存备份配置失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存备份配置失败: {e}"))
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
/// .toolbox 下的 backups 与 FTS 派生文件；备份流程自身的临时/暂存目录（原子性实现，
/// 崩溃残留应被忽略、不参与恢复候选）；临时文件。
fn is_skipped(parent: &Path, name: &str, at_root: bool) -> bool {
    if at_root && (name == "site" || name == ".git") {
        return true;
    }
    if at_root && (name == CONFIG_ARCHIVE || name == PLUGINS_ARCHIVE) {
        return true;
    }
    if parent.file_name().map(|n| n == ".toolbox").unwrap_or(false)
        && (name == "backups" || name.starts_with("search-fts.sqlite")) {
            return true;
        }
    // 备份/恢复的中间目录：.backup-*.tmp（快照暂存，rename 前）、
    // .restore-stage-*（恢复暂存，覆盖前校验用）。崩溃残留也被忽略。
    if name.starts_with(".backup-") || name.starts_with(".restore-stage") {
        return true;
    }
    name.ends_with(".tmp") || name.ends_with('~') || name == "desktop.ini"
}

/// 递归最大深度：恶意/意外的万层嵌套目录会让纯递归栈溢出直接 abort 进程
/// （Rust 栈溢出不可捕获）。超过上限：复制报错（备份中止），统计跳过。
const MAX_DEPTH: usize = 64;

/// 递归复制目录，返回（字节数, 文件数）。
fn copy_dir_all(src: &Path, dst: &Path, at_root: bool) -> Result<(u64, usize), String> {
    copy_dir_all_depth(src, dst, at_root, 0)
}

/// 判断路径是否为符号链接 / junction（Windows 重解析点）。
/// 备份时跳过：跟随会复制 vault 外的目录树，或把目录当文件复制导致整个备份中止。
fn is_symlink_or_junction(p: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT = 0x400：符号链接与 junction 都是重解析点
        std::fs::symlink_metadata(p)
            .map(|m| m.file_attributes() & 0x400 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::fs::symlink_metadata(p)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
    }
}

fn copy_dir_all_depth(
    src: &Path,
    dst: &Path,
    at_root: bool,
    depth: usize,
) -> Result<(u64, usize), String> {
    if depth > MAX_DEPTH {
        return Err(format!(
            "目录嵌套过深（>{MAX_DEPTH} 层），已中止复制: {}",
            src.display()
        ));
    }
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
        // 跳过符号链接 / junction：跟随会复制 vault 外的目录树，
        // 或把目录当文件复制导致整个备份中止
        if is_symlink_or_junction(&s) {
            continue;
        }
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let (sz, c) = copy_dir_all_depth(&s, &d, false, depth + 1)?;
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

/// 解析备份目录名时间戳：`backup-<ts>` 或 `backup-<ts>-<n>`（同名冲突后缀）→ ts。
/// 失败返回 None（不匹配的目录名/损坏）。
fn parse_backup_ts(name: &str) -> Option<i64> {
    name.strip_prefix("backup-")
        .and_then(|s| s.split('-').next())
        .and_then(|s| s.parse::<i64>().ok())
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
///
/// **排序必须按时间戳**：按文件名字符串排序会在跨位数边界删错——
/// `"backup-999999999"`（9 位，较早）字符串序排在 `"backup-1700000000"`（10 位）
/// 之后，会被误当作"较新"而保留。当前时间戳为 10 位不触发，但这是定时炸弹
/// （且 2286 年时间戳转 11 位时再次触发）。
fn prune(backups: &Path, keep: usize) {
    let Ok(read) = std::fs::read_dir(backups) else {
        return;
    };
    let mut dirs: Vec<_> = read
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            // 只认正式备份目录（.backup-*.tmp 等中间目录不参与清理）
            e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && parse_backup_ts(&name).is_some()
        })
        .collect();
    dirs.sort_by_key(|e| parse_backup_ts(&e.file_name().to_string_lossy()).unwrap_or(i64::MIN));
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
    dir_size_depth(dir, 0)
}

fn dir_size_depth(dir: &Path, depth: usize) -> u64 {
    if depth > MAX_DEPTH {
        // 超深子树跳过（防栈溢出 abort）
        return 0;
    }
    let mut total = 0u64;
    if let Ok(read) = std::fs::read_dir(dir) {
        for e in read.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                total += dir_size_depth(&e.path(), depth + 1);
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
    let final_dir = unique_backup_dir(&backups, ts);
    // 原子性（重要）：先复制到隐藏临时目录，全部成功后再 rename 为最终名。
    // 若在复制中途崩溃（托盘退出/断电），只留下 .backup-*.tmp 残留——
    // 它被 is_skipped 排除、不被 backup_list 列出、不参与 prune，
    // 绝不会出现"名字看起来完整、内容却半截"的备份被用户恢复覆盖线上数据。
    let tmp_dir = backups.join(format!(".backup-{ts}.tmp"));
    if tmp_dir.exists() {
        // 清理上一次崩溃留下的同名残留
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
    let (mut size, mut count) = copy_dir_all(&root, &tmp_dir, true)?;

    // 存档：应用配置（%APPDATA% 下 json） + 全局插件（排除核心 _core）
    let cfg_dir = PathBuf::from(config_dir);
    if let Ok((sz, c)) = copy_config_archive(&cfg_dir, &tmp_dir.join(CONFIG_ARCHIVE)) {
        size += sz;
        count += c;
    }
    if let Ok((sz, c)) = copy_plugins_archive(&cfg_dir.join("plugins"), &tmp_dir.join(PLUGINS_ARCHIVE))
    {
        size += sz;
        count += c;
    }

    // rename 提交（同目录同盘，目标不存在时原子）
    std::fs::rename(&tmp_dir, &final_dir)
        .map_err(|e| format!("提交备份目录失败: {e}"))?;

    if keep > 0 {
        prune(&backups, keep);
    }
    Ok(BackupInfo {
        path: final_dir.to_string_lossy().to_string(),
        size_bytes: size,
        file_count: count,
    })
}

/// 立即备份命令入口（更新计时后返回）。宿主命令与自动备份线程共用。
pub fn backup_now_cmd(config_dir: &str, vault: &str) -> Result<BackupInfo, String> {
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
    // 保持"0 = 用默认值"的既有语义
    if cfg.interval_minutes == 0 {
        cfg.interval_minutes = DEFAULT_INTERVAL_MIN;
    }
    if cfg.keep == 0 {
        cfg.keep = DEFAULT_KEEP;
    }
    // 范围钳制（防手改配置/异常输入引发灾难）：
    // - interval 上限 7 天：超大值会让后台线程 `(x as i64) * 60` 溢出 panic（debug）
    //   或行为异常（release）；- keep 上限 100：防止误配导致磁盘被备份堆满
    cfg.interval_minutes = cfg.interval_minutes.clamp(1, 7 * 24 * 60);
    cfg.keep = cfg.keep.clamp(1, 100);
    // last_backup_at 只接受合理值：非负且不超前超过 1 天
    // （异常值会让 `now - last` 溢出或永久不触发自动备份）
    if let Some(l) = cfg.last_backup_at {
        let now = unix_now();
        if l < 0 || l > now + 86_400 {
            cfg.last_backup_at = None;
        }
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
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        // 只列正式备份（.backup-*.tmp 等中间目录不列出）
        let Some(ts) = parse_backup_ts(&name) else {
            continue;
        };
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
///
/// **两阶段恢复（尽力事务）**：先完整复制到 vault 内暂存目录（此阶段只读备份源、
/// 写暂存，vault 不受影响——备份源损坏/IO 失败时线上数据安然无恙），
/// 成功后再覆盖合并到 vault 根，最后清理暂存。若覆盖阶段失败（概率低），
/// 暂存目录与恢复前的现场备份（backup-<ts>）都还在，可手工补救。
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

    // 阶段 1：完整复制到暂存目录（读源失败 → vault 未动，直接返回错误）
    let backups = backups_root(vault);
    let stage = backups.join(format!(".restore-stage-{}", unix_now()));
    if stage.exists() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    let (size, count) = copy_dir_all(&src, &stage, true)?;
    // 阶段 2：覆盖合并（at_root=true：同样跳过 site/.git 与存档目录）
    copy_dir_all(&stage, &root, true)?;
    let _ = std::fs::remove_dir_all(&stage);

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
/// 启用且到期则备份当前工作区。宿主 setup 调用。
pub fn spawn_auto(config_dir: String) {
    static STARTED: OnceLock<()> = OnceLock::new();
    let _ = STARTED.get_or_init(|| {
        std::thread::spawn(move || loop {
            std::thread::sleep(CHECK_INTERVAL);
            let cfg = load_config(&config_dir);
            if !cfg.enabled {
                continue;
            }
            // clamp + saturating_sub 双保险：配置可能被手改出异常值
            // （backup_config_set 已钳制，但 backup.json 文件可被外部编辑），
            // 防止 `(x as i64) * 60` / `now - last` 整数溢出 panic 杀死后台线程。
            let interval = (cfg.interval_minutes.clamp(1, 7 * 24 * 60) as i64) * 60;
            let last = cfg.last_backup_at.unwrap_or(0);
            let now = unix_now();
            if now.saturating_sub(last) < interval {
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
    fn prune_sorts_by_timestamp_not_name() {
        // 回归：字符串排序会在跨位数边界删错（"backup-999999999" 9 位早于
        // "backup-1700000000" 10 位，但字符串序排在其后）。按时间戳排序后
        // 应保留 10 位的（较新）。
        let v = tmp_dir("prune-ts");
        let backups = v.join(".toolbox/backups");
        std::fs::create_dir_all(&backups).unwrap();
        std::fs::create_dir_all(backups.join("backup-999999999")).unwrap();
        std::fs::create_dir_all(backups.join("backup-1700000000")).unwrap();
        prune(&backups, 1);
        let left: Vec<_> = std::fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            left.iter().any(|n| n == "backup-1700000000"),
            "应保留时间戳更大的备份: {left:?}"
        );
        assert!(!left.iter().any(|n| n == "backup-999999999"), "应删掉更旧的: {left:?}");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn backup_is_atomic_no_tmp_residue() {
        // 原子性：backup_now 完成后不应残留 .backup-*.tmp 中间目录，
        // 且 backup_list 不列出中间目录（崩溃残留会被忽略，不参与恢复候选）。
        let v = tmp_dir("atomic");
        let vault = v.to_str().unwrap();
        let config_dir = tmp_dir("atomic-cfg");
        std::fs::create_dir_all(v.join("notes")).unwrap();
        std::fs::write(v.join("notes/a.md"), "# a").unwrap();
        let info = backup_now(config_dir.to_str().unwrap(), vault, 5).unwrap();
        assert!(Path::new(&info.path).is_dir(), "最终备份目录应存在");
        let backups = v.join(".toolbox/backups");
        let names: Vec<_> = std::fs::read_dir(&backups)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            !names.iter().any(|n| n.starts_with('.')),
            "不应有中间/残留目录: {names:?}"
        );
        let listed: Vec<_> = backup_list(vault).iter().map(|b| b.name.clone()).collect();
        assert_eq!(listed.len(), 1, "backup_list 只列正式备份: {listed:?}");
        std::fs::remove_dir_all(&v).ok();
        std::fs::remove_dir_all(&config_dir).ok();
    }

    #[test]
    fn config_set_clamps_extremes() {
        // 溢出钳制：异常大值/异常 last_backup_at 被钳到安全范围，
        // 后台线程不会因整数溢出 panic（debug）或行为异常（release）。
        let config_dir = tmp_dir("cfg-clamp");
        let cfg = BackupConfig {
            enabled: true,
            interval_minutes: 1 << 40, // 极大值
            keep: usize::MAX,
            last_backup_at: Some(i64::MIN),
        };
        backup_config_set(config_dir.to_str().unwrap(), cfg).unwrap();
        let saved = load_config(config_dir.to_str().unwrap());
        assert!(saved.interval_minutes <= 7 * 24 * 60, "interval 应被钳制");
        assert!(saved.keep <= 100, "keep 应被钳制");
        assert!(saved.last_backup_at.is_none(), "异常 last_backup_at 应被清空");

        // 0 = 默认值语义保留
        let cfg2 = BackupConfig {
            enabled: true,
            interval_minutes: 0,
            keep: 0,
            last_backup_at: None,
        };
        backup_config_set(config_dir.to_str().unwrap(), cfg2).unwrap();
        let saved2 = load_config(config_dir.to_str().unwrap());
        assert_eq!(saved2.interval_minutes, DEFAULT_INTERVAL_MIN);
        assert_eq!(saved2.keep, DEFAULT_KEEP);
        std::fs::remove_dir_all(&config_dir).ok();
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
