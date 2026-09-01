//! 取消机制（移植自 Python `probe_layer/cancel.py`）。
//!
//! 后台任务用 `Arc<AtomicBool>` 作取消标志，热循环周期性 `check_cancel`，
//! 置位后干净抛出 `LayeringCancelled`（不崩、不残留中间态）。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// 取消标志（`true` = 已请求取消）。
pub type CancelFlag = Arc<AtomicBool>;

/// 取消即中断的异常类型（无数据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayeringCancelled;

impl std::fmt::Display for LayeringCancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "任务已取消")
    }
}

impl std::error::Error for LayeringCancelled {}

/// 若已请求取消则返回 `Err(LayeringCancelled)`，否则 `Ok(())`。
pub fn check_cancel(flag: &CancelFlag) -> Result<(), LayeringCancelled> {
    if flag.load(Ordering::Relaxed) {
        Err(LayeringCancelled)
    } else {
        Ok(())
    }
}

pub fn new_cancel() -> CancelFlag {
    Arc::new(AtomicBool::new(false))
}
