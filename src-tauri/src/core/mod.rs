//! 核心能力层：数据、文件与业务逻辑。
//!
//! M0 阶段仅作占位，规划如下：
//! - `vault`    工作区（Vault）文件管理：文件树、读写、变更监视
//! - `storage`  结构化数据：清单 / 记录（JSON）、SQLite 索引与全文搜索
//! - `ai`       AI 网关：多提供商（OpenAI 兼容）、流式对话、嵌入
//! - `git`      Git 集成：备份与版本历史（基于 git2 crate）
//!
//! 各子模块在对应里程碑（M1 笔记、M4 清单与记录、M6 AI、后续备份）中落地。

// 预留：后续按里程碑拆分文件，如 `pub mod vault; pub mod storage; pub mod ai;`
