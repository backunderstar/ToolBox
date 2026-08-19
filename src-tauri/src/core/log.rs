//! 运行日志落盘：`%APPDATA%/com.toolbox.desktop/logs/toolbox-YYYY-MM-DD.log`。
//!
//! 打包版没有终端，关键运行日志（启动/浮窗/插件生命周期/前端错误/搜索失败）
//! 写文件便于排查；行格式 `YYYY-MM-DD HH:MM:SS [级别] 消息`，按天滚动。
//! 不引入 tracing：现有散布的 eprintln 就地替换为 log_line（文件 + stderr 双写），
//! dev 终端可见性不变；文件写入失败静默（日志不干扰运行）。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 日志目录（`%APPDATA%/com.toolbox.desktop/logs/`）；setup 时经 `init` 注入。
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
/// 写锁：进程内并发写一行不交错（全局锁足够）。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// setup 阶段调用：注入日志目录（不存在则创建；失败静默——日志降级为仅终端）。
pub fn init(config_dir: &str) {
    let dir = PathBuf::from(config_dir).join("logs");
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = LOG_DIR.set(dir);
    }
}

/// 写一行日志：双写文件 + stderr（未初始化/写失败时仅终端）。
pub fn log_line(level: &str, msg: &str) {
    let ts = tb_sdk::now_iso();
    let line = format!("{ts} [{level}] {msg}");
    eprintln!("{line}");
    let Some(dir) = LOG_DIR.get() else {
        return; // 未初始化（浏览器预览/测试）：仅终端
    };
    let date = &ts[..10]; // YYYY-MM-DD（now_iso 前 10 字符）
    let path = dir.join(format!("toolbox-{date}.log"));
    let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// 便捷级别封装。
pub fn info(msg: &str) {
    log_line("info", msg);
}

pub fn warn(msg: &str) {
    log_line("warn", msg);
}

pub fn error(msg: &str) {
    log_line("error", msg);
}
