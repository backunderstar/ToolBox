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
/// 只更新共享状态（`layer.status` 轮询）；若注入了日志回调（`set_log`，
/// 由 dispatch 注入 `tb_sdk::log`），可同时把阶段明细打到宿主日志。
pub struct Progress<'a> {
    pub state: &'a Arc<Mutex<ActiveStateData>>,
    pub cancel: &'a CancelFlag,
    /// 宿主日志回调（`tb_sdk::log` level 0=info/1=warn/2=error）；未注入则静默。
    log: Option<Box<dyn Fn(i32, &str)>>,
}

impl<'a> Progress<'a> {
    pub fn new(state: &'a Arc<Mutex<ActiveStateData>>, cancel: &'a CancelFlag) -> Self {
        Self { state, cancel, log: None }
    }

    /// 注入宿主日志回调（dispatch 用 `tb_sdk::log` 包装）；不调用则不产生日志。
    pub fn set_log(&mut self, log: impl Fn(i32, &str) + 'static) {
        self.log = Some(Box::new(log));
    }

    pub fn log_info(&self, msg: &str) {
        self.emit_log(0, msg);
    }
    pub fn log_warn(&self, msg: &str) {
        self.emit_log(1, msg);
    }
    pub fn log_error(&self, msg: &str) {
        self.emit_log(2, msg);
    }
    fn emit_log(&self, level: i32, msg: &str) {
        if let Some(f) = &self.log {
            f(level, msg);
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::Mutex;

    #[test]
    fn log_routes_to_injected_callback_with_levels() {
        let state: Arc<Mutex<ActiveStateData>> = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = crate::cancel::new_cancel();
        let mut prog = Progress::new(&state, &cancel);
        let collected: Arc<Mutex<Vec<(i32, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&collected);
        prog.set_log(move |level, msg| {
            sink.lock().unwrap().push((level, msg.to_string()));
        });

        prog.log_info("info msg");
        prog.log_warn("warn msg");
        prog.log_error("error msg");

        let got = collected.lock().unwrap();
        assert_eq!(
            *got,
            vec![
                (0, "info msg".to_string()),
                (1, "warn msg".to_string()),
                (2, "error msg".to_string()),
            ]
        );
    }

    #[test]
    fn log_is_silent_without_callback() {
        let state: Arc<Mutex<ActiveStateData>> = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = crate::cancel::new_cancel();
        let prog = Progress::new(&state, &cancel);
        // 不注入回调：log_* 应静默（不 panic）
        prog.log_info("a");
        prog.log_warn("b");
        prog.log_error("c");
    }
}
