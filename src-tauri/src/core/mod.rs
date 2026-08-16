//! 核心能力层：数据、文件与业务逻辑。
//!
//! - `path`    路径安全工具（vault 相对路径解析）
//! - `vault`   Vault 工作区：路径选择与持久化（M1 落地）
//!
//! 笔记/记录/清单/项目/待办/博客/AI/搜索/备份 已迁移为原生核心插件
//! （core-plugins/*，cdylib）。

pub mod path;
pub mod vault;
