//! 核心能力层：数据、文件与业务逻辑。
//!
//! - `app`     应用外壳域：应用设置/托盘/窗口/浮窗/系统集成命令
//!   （2026-09 从 lib.rs 957 行单体拆出，命令按域归位）
//! - `path`    路径安全工具（vault 相对路径解析）
//! - `vault`   Vault 工作区：路径选择与持久化（M1 落地）
//! - `workspaces` 多工作区：工作区根目录 + 当前工作区（2026-09；vault 是其单工作区回退）
//! - `files`   宿主文件服务：vault 内文件列表/读写/增删改（系统级横切能力，
//!   插件核心 API 与宿主数据层共用，2026-08 迁回本体）
//! - `search`  全文搜索（SQLite FTS5，宿主内嵌横切能力）
//! - `backup`  自动备份（快照/配置/插件存档 + 恢复，宿主内嵌数据安全兜底）
//! - `config`  配置导入导出（换机迁移：前端 localStorage + 宿主配置合成）
//! - `log`     运行日志落盘（%APPDATA%/…/logs/，按天滚动，双写终端）
//!
//! 业务插件为原生核心插件（core-plugins/*，cdylib；教学基线仅 core-example）。

pub mod app;
pub mod backup;
pub mod config;
pub mod files;
pub mod log;
pub mod path;
pub mod search;
pub mod vault;
pub mod workspaces;
