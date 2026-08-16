//! 核心能力层：数据、文件与业务逻辑。
//!
//! - `path`    路径安全工具（vault 相对路径解析）
//! - `vault`   Vault 工作区：路径选择与持久化（M1 落地）
//! - `search`  全文搜索（SQLite FTS5，宿主内嵌横切能力）
//! - `backup`  自动备份（快照/配置/插件存档 + 恢复，宿主内嵌数据安全兜底）
//!
//! 笔记/记录/清单/项目/待办/博客/AI 为原生核心插件（core-plugins/*，cdylib）。

pub mod backup;
pub mod path;
pub mod search;
pub mod vault;
