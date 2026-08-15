//! 路径安全工具：vault 相对路径 → 绝对路径（拒绝越界）。

use std::path::{Component, Path, PathBuf};

/// 将 vault 相对路径（UI 统一 `/` 分隔）解析为绝对路径。
/// 严格拒绝绝对路径、`..`、根路径与盘符前缀，防止越出工作区。
pub fn resolve_safe(vault: &str, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let rel_path = Path::new(&rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("非法路径: {rel}"));
    }
    Ok(PathBuf::from(vault).join(rel_path))
}
