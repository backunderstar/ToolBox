//! RPC 协议层：核心与插件进程之间的通信协议。
//!
//! JSON-RPC 2.0 风格 over stdio（NDJSON，每行一个 JSON 对象）。
//! 核心与 Python / 未来任意语言插件之间统一使用此协议：
//!
//! ```text
//! 核心 → 插件   Request   {id, method: "call",  params: {command, args}}
//! 核心 → 插件   Request   {id, method: "init",  params: {apiVersion, pluginId}}
//! 插件 → 核心   Response  {id, result} / {id, error}
//! 插件 → 核心   Request   {id, method: "fs.readText", params: {path}}   // 调用核心 API
//! 核心 → 插件   Response  {id, result}
//! 核心 → 插件   Notification {method: "shutdown"}
//! ```
//!
//! 任一门语言只要实现"读 stdin 一行 JSON、写 stdout 一行 JSON"即可成为插件。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

/// 核心 ↔ 插件 的消息。`untagged` 依靠字段形态区分：
/// - {id, method, params}           → Request
/// - {id, result} / {id, error}     → Response
/// - {method, params}（无 id）      → Notification（事件/命令）
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum Message {
    Request {
        id: u64,
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
    },
    Response {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<RpcError>,
    },
    Notification {
        method: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        params: Option<Value>,
    },
}

impl Message {
    pub fn request(id: u64, method: &str, params: Value) -> Self {
        Message::Request {
            id,
            method: method.to_string(),
            params: Some(params),
        }
    }

    pub fn response_ok(id: u64, result: Value) -> Self {
        Message::Response {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn response_err(id: u64, code: i32, message: String) -> Self {
        Message::Response {
            id,
            result: None,
            error: Some(RpcError { code, message }),
        }
    }

    pub fn notification(method: &str, params: Option<Value>) -> Self {
        Message::Notification {
            method: method.to_string(),
            params,
        }
    }
}

/// 单条消息序列化为 NDJSON（带换行结尾）。
pub fn encode(msg: &Message) -> Result<String, String> {
    let mut line = serde_json::to_string(msg).map_err(|e| format!("序列化失败: {e}"))?;
    line.push('\n');
    Ok(line)
}

/// 解析单行 NDJSON。
pub fn decode(line: &str) -> Result<Message, String> {
    serde_json::from_str(line).map_err(|e| format!("解析失败: {e}"))
}
