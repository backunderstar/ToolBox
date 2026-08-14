//! 插件系统：插件清单解析、加载与生命周期管理。
//!
//! M0 阶段仅作占位。规划（M2 里程碑落地）：
//! - `manifest`  解析 `plugin.json`（id / runtime / command / permissions）
//! - `process`   子进程桥：启动、stdin/stdout JSON-RPC、超时与崩溃重启
//! - `registry`  插件注册表：启用/禁用、热重载、版本管理
//!
//! 两类运行时：
//! - `webview` 插件：JS/TS，运行于界面内，可注册 UI（命令面板、面板、状态栏）
//! - `process` 插件：Python 等任意语言，经 rpc 协议调用核心 API

// 预留：`pub mod manifest; pub mod process; pub mod registry;`
