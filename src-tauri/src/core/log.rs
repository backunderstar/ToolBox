//! 运行日志落盘：`%APPDATA%/com.toolbox.desktop/logs/toolbox-YYYY-MM-DD.log`。
//!
//! 打包版没有终端，关键运行日志（启动/浮窗/插件生命周期/前端错误/搜索失败）
//! 写文件便于排查；行格式 `YYYY-MM-DD HH:MM:SS [级别] 消息`，按天滚动。
//! 不引入 tracing：现有散布的 eprintln 就地替换为 log_line（文件 + stderr 双写），
//! dev 终端可见性不变；文件写入失败静默（日志不干扰运行）。
//!
//! 级别：debug < info < warn < error（`set_level` 运行时切换，默认 info）；
//! 低于阈值的行跳过（文件与终端都不写）。
//! 保留：默认保留最近 `RETAIN_DAYS` 天，`prune` 删除超期文件（init 时 +
//! 每天跨天首写时调用）。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};

/// 日志目录（`%APPDATA%/com.toolbox.desktop/logs/`）；setup 时经 `init` 注入。
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 当日日志文件句柄缓存（date → File）：避免每行都重新 open/close 文件——
/// 高频日志场景（前端错误转发、插件事件）下开文件是明显的系统调用开销。
/// 该锁同时充当写锁（跨行串行写，一行不交错）。
static DAY_FILE: Mutex<Option<(String, File)>> = Mutex::new(None);
/// 当前日志级别（0=debug, 1=info, 2=warn, 3=error；默认 info）。
static LEVEL: AtomicU8 = AtomicU8::new(1);
/// 日志保留天数（超期文件自动清理）。
pub const RETAIN_DAYS: u64 = 7;

/// setup 阶段调用：注入日志目录（不存在则创建；失败静默——日志降级为仅终端），
/// 并清理超期日志文件。
pub fn init(config_dir: &str) {
    let dir = PathBuf::from(config_dir).join("logs");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = LOG_DIR.set(dir);
    }
    prune(RETAIN_DAYS);
}

/// 设置日志级别（"debug"|"info"|"warn"|"error"；未知值忽略）。
pub fn set_level(name: &str) {
    let lvl = match name {
        "debug" => 0,
        "info" => 1,
        "warn" => 2,
        "error" => 3,
        _ => return,
    };
    LEVEL.store(lvl, Ordering::Relaxed);
}

/// 当前日志级别名。
pub fn level_name() -> &'static str {
    match LEVEL.load(Ordering::Relaxed) {
        0 => "debug",
        2 => "warn",
        3 => "error",
        _ => "info",
    }
}

/// 日历日序号（civil days since 1970-01-01；days-from-civil 算法，UTC 近似。
/// 清理粒度是按天，本地/UTC 偏差一天内无碍）。
fn days_from_civil(y: i64, m: u64, d: u64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // [0, 11]
    let doy = (153 * mp + 2) / 5 + (d - 1);
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as i64;
    era * 146097 + doe - 719468
}

/// 今天（now_iso 前 10 字符 "YYYY-MM-DD"）的日历日序号。
fn today_days() -> i64 {
    let date = &tb_sdk::now_iso()[..10];
    parse_date_days(date).unwrap_or(0)
}

/// 解析 "YYYY-MM-DD" → 日历日序号。
fn parse_date_days(date: &str) -> Option<i64> {
    let b = date.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |s: &[u8]| -> Option<i64> {
        let t: String = s.iter().map(|c| *c as char).collect();
        t.parse().ok()
    };
    let y = num(&b[0..4])?;
    let m = num(&b[5..7])?;
    let d = num(&b[8..10])?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m as u64, d as u64))
}

/// 删除超过保留天数的日志文件（按文件名日期 `toolbox-YYYY-MM-DD.log` 判断；
/// 解析失败/非本格式文件不动）。
pub fn prune(retain_days: u64) {
    let Some(dir) = LOG_DIR.get() else {
        return;
    };
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = today_days() - retain_days as i64;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(date) = name
            .strip_prefix("toolbox-")
            .and_then(|s| s.strip_suffix(".log"))
        else {
            continue;
        };
        if let Some(days) = parse_date_days(date) {
            if days < cutoff {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// 写一行日志：级别低于阈值跳过；否则双写文件 + stderr。
pub fn log_line(level: &str, lvl: u8, msg: &str) {
    if lvl < LEVEL.load(Ordering::Relaxed) {
        return; // 低于阈值：不落盘不打印
    }
    let ts = tb_sdk::now_iso();
    let line = format!("{ts} [{level}] {msg}");
    eprintln!("{line}");
    let Some(dir) = LOG_DIR.get() else {
        return; // 未初始化（浏览器预览/测试）：仅终端
    };
    let date = &ts[..10]; // YYYY-MM-DD（now_iso 前 10 字符）
    let mut day = DAY_FILE.lock().unwrap_or_else(|p| p.into_inner());
    // 按天滚动：日期变化时重新打开当天文件（句柄缓存当日；跨天首次写重开）。
    // 文件被外部删除/移动时 append 写失败静默（与旧行为一致：日志不干扰运行）。
    if day.as_ref().map(|(d, _)| d.as_str()) != Some(date) {
        let path = dir.join(format!("toolbox-{date}.log"));
        *day = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()
            .map(|f| (date.to_string(), f));
        // 跨天首写顺便清理超期日志
        prune(RETAIN_DAYS);
    }
    if let Some((_, f)) = day.as_mut() {
        let _ = writeln!(f, "{line}");
    }
}

/// 便捷级别封装。
pub fn debug(msg: &str) {
    log_line("debug", 0, msg);
}

pub fn info(msg: &str) {
    log_line("info", 1, msg);
}

pub fn warn(msg: &str) {
    log_line("warn", 2, msg);
}

pub fn error(msg: &str) {
    log_line("error", 3, msg);
}
