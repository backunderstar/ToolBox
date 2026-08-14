//! RPC 协议层：核心与插件进程之间的通信协议。
//!
//! M0 阶段仅作占位。规划：JSON-RPC 2.0 over stdio（NDJSON），
//! 核心与 Python / 未来任意语言插件之间，每行一个 JSON 对象：
//!
//! ```text
//! 核心 → 插件   call    {id, method, params}
//! 插件 → 核心   result  {id, result} / {id, error}
//! 插件 → 核心   invoke  {method, params}      // 插件反向调用核心 API
//! 核心 → 插件   event   {event, data}        // 事件广播
//! ```
//!
//! M2（插件系统 v1）在此实现协议类型（serde 结构）、帧解析与错误码。

// 预留：`pub mod protocol; pub mod framing;`
