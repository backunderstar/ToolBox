//! 插件事件桥：进程插件事件 → 前端（`plugin-event` 事件）。
//!
//! - 插件进程在 JSON-RPC 流上发 **Notification**（`{method: <事件名>, params: <数据>}`，
//!   无 id）→ read_loop 解析为 `Incoming::Event` → ProcessPlugin 直接经注入的
//!   `Sender<PluginEvent>`（来自 `sender()`）入总线 → 转发线程
//!   `app.emit("plugin-event", ...)` → 前端监听
//! - **设计约束（重要）**：ProcessPlugin 只持有标准库的 `SyncSender<PluginEvent>`，
//!   绝不接触 `AppHandle` 等 tauri 类型——此前在 ProcessPlugin 里存 AppHandle
//!   曾触发测试二进制加载崩溃（0xC0000139），事件总线方案彻底绕开该路径
//! - **有界通道**：失控/恶意进程无限推事件时，通道满 → 插件读线程阻塞（天然
//!   背压），不会无界积压占满内存；1024 容量对正常低频事件绰绰有余

use serde::Serialize;
use serde_json::Value;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::OnceLock;

/// 事件总线容量：瞬时峰值缓冲（正常插件事件低频），同时限制失控进程积压。
pub const EVENT_CAP: usize = 1024;

/// 前端收到的插件事件载荷（`plugin-event`）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginEvent {
    pub plugin_id: String,
    pub event: String,
    pub data: Value,
}

/// 进程级事件总线（OnceLock：应用生命周期内只初始化一次）
static EVENT_TX: OnceLock<SyncSender<PluginEvent>> = OnceLock::new();

/// 初始化总线并返回接收端（应用 setup 时调用一次，转发线程持有）。
pub fn init_bridge() -> Receiver<PluginEvent> {
    let (tx, rx) = sync_channel(EVENT_CAP);
    let _ = EVENT_TX.set(tx);
    rx
}

/// 当前事件发送端（生产 spawn 用；测试直接自建通道传入，不走全局）。
pub fn sender() -> Option<SyncSender<PluginEvent>> {
    EVENT_TX.get().cloned()
}

/// 事件转发线程：总线 → 前端 `plugin-event` 事件（AppHandle 只存在于本线程）。
pub fn spawn_event_forwarder(app: tauri::AppHandle) {
    let rx = init_bridge();
    std::thread::spawn(move || {
        use tauri::Emitter;
        while let Ok(ev) = rx.recv() {
            let _ = app.emit("plugin-event", ev);
        }
    });
}
