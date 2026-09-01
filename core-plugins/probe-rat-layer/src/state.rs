//! 活动任务状态 + 进度/取消报告器（后台任务与 `layer.status` 轮询共用）。

use crate::cancel::{check_cancel, CancelFlag, LayeringCancelled};
use std::sync::{Arc, Mutex};

/// 单任务活动状态（`layer.status` 返回的字段）。
#[derive(Debug, Clone)]
pub struct ActiveStateData {
    pub job_id: Option<String>,
    pub state: String, // idle | running | done | failed | cancelled
    pub stage: String,
    pub percent: f64,
    pub message: String,
    pub error: Option<String>,
}

impl Default for ActiveStateData {
    fn default() -> Self {
        Self {
            job_id: None,
            state: "idle".to_string(),
            stage: String::new(),
            percent: 0.0,
            message: String::new(),
            error: None,
        }
    }
}

/// 进度报告器：后台线程经它在热循环里更新共享状态并检查取消。
/// 只更新共享状态（`layer.status` 轮询）、不直接接触宿主 ctx（`emit` 由外层线程负责）。
pub struct Progress<'a> {
    pub state: &'a Arc<Mutex<ActiveStateData>>,
    pub cancel: &'a CancelFlag,
}

impl<'a> Progress<'a> {
    pub fn new(state: &'a Arc<Mutex<ActiveStateData>>, cancel: &'a CancelFlag) -> Self {
        Self { state, cancel }
    }
    pub fn set(&self, stage: &str, pct: f64, msg: &str) {
        if let Ok(mut s) = self.state.lock() {
            s.stage = stage.to_string();
            s.percent = pct;
            s.message = msg.to_string();
        }
    }
    pub fn check_cancel(&self) -> Result<(), LayeringCancelled> {
        check_cancel(self.cancel)
    }
    pub fn cancel_flag(&self) -> &'a CancelFlag {
        self.cancel
    }
}
