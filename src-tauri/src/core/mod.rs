//! 核心能力层：数据、文件与业务逻辑。
//!
//! - `path`    路径安全工具（vault 相对路径解析）
//! - `vault`   Vault 工作区：路径选择与持久化（M1 落地）
//! - `ai`      AI 网关：多提供商、对话、连通性测试（M6 落地）
//! - `blog`    博客发布：frontmatter、站点生成与预览（M7 落地）
//! - `backup`   自动备份：vault → .toolbox/backups，保留 N 份（Backlog 落地）
//! - `search`   全文搜索：SQLite FTS5 索引（vault/.toolbox/search-fts.sqlite）
//!
//! 笔记/记录/清单/项目/待办 已迁移为原生核心插件（core-plugins/*，cdylib）。

pub mod ai;
pub mod backup;
pub mod blog;
pub mod path;
pub mod search;
pub mod vault;
