//! 插件事件桥：进程插件事件 → 前端（`plugin-event` 事件）。
//!
//! - 插件进程在 JSON-RPC 流上发 **Notification**（`{method: <事件名>, params: <数据>}`，
//!   无 id）→ read_loop 解析为 `Incoming::Event` → ProcessPlugin 经本模块的
//!   mpsc 总线转发 → 转发线程 `app.emit("plugin-event", ...)` → 前端监听
//! - **设计约束（重要）**：ProcessPlugin 只持有标准库的 `Sender<PluginEvent>`，
//!   绝不接触 `AppHandle` 等 tauri 类型——此前在 ProcessPlugin 里存 AppHandle
//!   曾触发测试二进制加载崩溃（0xC0000139），事件总线方案彻底绕开该路径

use serde::Serialize;
use serde_json::Value;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;

/// 前端收到的插件事件载荷（`plugin-event`）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginEvent {
    pub plugin_id: String,
    pub event: String,
    pub data: Value,
}

/// 进程级事件总线（OnceLock：应用生命周期内只初始化一次）
static EVENT_TX: OnceLock<Sender<PluginEvent>> = OnceLock::new();

/// 初始化总线并返回接收端（应用 setup 时调用一次，转发线程持有）。
pub fn init_bridge() -> Receiver<PluginEvent> {
    let (tx, rx) = channel();
    let _ = EVENT_TX.set(tx);
    rx
}

/// 插件事件入总线（ProcessPlugin 转发用；总线未初始化时静默丢弃）。
pub fn emit(plugin_id: &str, event: &str, data: Value) {
    if let Some(tx) = EVENT_TX.get() {
        let _ = tx.send(PluginEvent {
            plugin_id: plugin_id.to_string(),
            event: event.to_string(),
            data,
        });
    }
}

/// 当前事件发送端（生产 spawn 用；测试直接自建 channel 传入，不走全局）。
pub fn sender() -> Option<Sender<PluginEvent>> {
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
