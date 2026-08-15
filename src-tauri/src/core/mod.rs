//! 核心能力层：数据、文件与业务逻辑。
//!
//! - `path`    路径安全工具（vault 相对路径解析）
//! - `vault`   Vault 工作区：路径选择与持久化（M1 落地）
//! - `notes`   笔记文件操作：列表/读写/新建/删除/重命名/搜索（M1 落地）
//! - `storage` 结构化数据：清单 / 记录（JSON）、SQLite 索引（M4 规划）
//! - `ai`      AI 网关：多提供商、流式对话、嵌入（M6 规划）
//! - `git`     Git 集成：备份与版本历史（后续规划）

pub mod notes;
pub mod path;
pub mod vault;
