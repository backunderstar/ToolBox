//! 核心能力层：数据、文件与业务逻辑。
//!
//! - `path`    路径安全工具（vault 相对路径解析）
//! - `vault`   Vault 工作区：路径选择与持久化（M1 落地）
//! - `notes`   笔记文件操作：列表/读写/新建/删除/重命名/搜索（M1 落地）
//! - `ai`      AI 网关：多提供商、对话、连通性测试（M6 落地）
//! - `blog`    博客发布：frontmatter、站点生成与预览（M7 落地）
//! - `projects` 项目文件管理：项目目录/归档/默认应用打开（M8 落地）
//! - `backup`   自动备份：vault → .toolbox/backups，保留 N 份（Backlog 落地）
//! - `git`     Git 集成：备份与版本历史（后续规划）

pub mod ai;
pub mod backup;
pub mod blog;
pub mod notes;
pub mod path;
pub mod projects;
pub mod vault;
