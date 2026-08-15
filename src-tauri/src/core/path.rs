//! 路径安全工具：相对路径 → 绝对路径（拒绝越界）。

use std::path::{Component, Path, PathBuf};

/// 将相对路径（UI 统一 `/` 分隔）解析为 `root` 下的绝对路径。
/// 严格拒绝：空串、`.`/`..`、绝对路径、根路径与盘符前缀，防止越出 root。
pub fn resolve_relative(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("路径为空".to_string());
    }
    let rel_path = Path::new(&rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("非法路径: {rel}"));
    }
    let joined = root.join(rel_path);
    // 纵深防御：规范化后再确认仍在 root 内（处理符号链接/`..` 残留等）
    let root_canon = canonical_parent(root);
    let joined_canon = canonical_parent(&joined);
    if let (Some(rc), Some(jc)) = (root_canon, joined_canon) {
        if !jc.starts_with(&rc) {
            return Err(format!("路径越出根目录: {rel}"));
        }
    }
    Ok(joined)
}

/// 将 vault 相对路径解析为绝对路径（根 = vault 目录）。
pub fn resolve_safe(vault: &str, rel: &str) -> Result<PathBuf, String> {
    resolve_relative(Path::new(vault), rel)
}

/// 对路径做规范化（存在时 canonicalize；不存在时对最近存在的祖先规范化后拼接），
/// 用于越界复核。失败返回 None（复核跳过，交由上层防御）。
fn canonical_parent(p: &Path) -> Option<PathBuf> {
    if let Ok(c) = p.canonicalize() {
        return Some(c);
    }
    // 逐级向上找存在的祖先
    let mut cur = p.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !cur.exists() {
        let Some(name) = cur.file_name().map(|n| n.to_os_string()) else {
            return None;
        };
        tail.push(name);
        if !cur.pop() {
            return None;
        }
    }
    let mut base = cur.canonicalize().ok()?;
    for part in tail.iter().rev() {
        base.push(part);
    }
    Some(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_curdir() {
        let vault = "C:/vault";
        assert!(resolve_safe(vault, "").is_err());
        assert!(resolve_safe(vault, "  ").is_err());
        assert!(resolve_safe(vault, ".").is_err());
        assert!(resolve_safe(vault, "./x.md").is_err());
    }

    #[test]
    fn rejects_escape() {
        let vault = "C:/vault";
        assert!(resolve_safe(vault, "../x.md").is_err());
        assert!(resolve_safe(vault, "a/../../x").is_err());
        assert!(resolve_safe(vault, "/abs").is_err());
        assert!(resolve_safe(vault, "C:/other").is_err());
        assert!(resolve_safe(vault, "\\\\.\\pipe\\x").is_err());
    }

    #[test]
    fn accepts_normal() {
        let vault = "C:/vault";
        let p = resolve_safe(vault, "notes/你好.md").unwrap();
        assert_eq!(p, std::path::PathBuf::from("C:/vault/notes/你好.md"));
        // 反斜杠归一化 + 前后空白裁剪
        let p2 = resolve_safe(vault, "  notes\\a.md ").unwrap();
        assert_eq!(p2, std::path::PathBuf::from("C:/vault/notes/a.md"));
    }
}
