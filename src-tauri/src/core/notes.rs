//! 笔记文件操作：列表 / 读写 / 新建 / 删除 / 重命名 / 搜索。
//!
//! 所有路径均为 vault 相对路径（UI 统一用 `/` 分隔），
//! 由 `core::path::resolve_safe` 严格校验，防止越出工作区。

use crate::core::path::resolve_safe;
use serde::Serialize;
use std::path::{Path, PathBuf};

const IGNORED_DIRS: &[&str] = &[".git", ".toolbox", "node_modules", "target", "site"];
/// 笔记统一存放目录（vault/notes/），文件树与搜索都只作用于该目录。
/// 由 `search` 模块共享（FTS 索引同样只扫这里）。
pub(crate) const NOTES_DIR: &str = "notes";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String, // vault 相对路径，/ 分隔
    pub is_dir: bool,
}

/// 确保 notes/ 目录存在；首次使用时把旧布局（vault 根下的 .md）迁移进去。
/// 幂等：目录已存在时直接返回。
fn ensure_notes_dir(root: &Path) -> Result<PathBuf, String> {
    let notes = root.join(NOTES_DIR);
    if notes.is_dir() {
        return Ok(notes);
    }
    std::fs::create_dir_all(&notes).map_err(|e| format!("创建笔记目录失败: {e}"))?;
    // 迁移旧布局：仅移动 vault 根层的 .md（data/plugins/.toolbox/site 等子目录不动）
    if let Ok(read) = std::fs::read_dir(root) {
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".md") && entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                let _ = std::fs::rename(entry.path(), notes.join(&name));
            }
        }
    }
    Ok(notes)
}

/// 递归列出 notes/ 目录下所有子目录与 .md 文件（忽略隐藏/无关目录），
/// 目录优先、按名排序。返回路径带 `notes/` 前缀（相对 vault，供读写/搜索使用）。
#[tauri::command]
pub async fn fs_list(vault: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("工作区不存在: {vault}"));
    }
    let notes = ensure_notes_dir(&root)?;
    let mut out = Vec::new();
    walk(&notes, &notes, NOTES_DIR, &mut out);
    Ok(out)
}

fn walk(root: &Path, dir: &Path, base: &str, out: &mut Vec<FileEntry>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let rel = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            out.push(FileEntry { name, path: rel.clone(), is_dir: true });
            walk(root, &entry.path(), &rel, out);
        } else if name.ends_with(".md") {
            out.push(FileEntry { name, path: rel, is_dir: false });
        }
    }
}

/// 列出 vault 内指定目录下的全部条目（不过滤扩展名）。
/// 供清单/记录等 JSON 数据枚举（fs_list 仅返回 .md 文件，专用于笔记文件树）。
#[tauri::command]
pub async fn fs_list_dir(vault: String, dir: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Err(format!("工作区不存在: {vault}"));
    }
    let target = resolve_safe(&vault, &dir)?;
    if !target.is_dir() {
        return Ok(Vec::new());
    }
    let Ok(read) = std::fs::read_dir(&target) else {
        return Ok(Vec::new());
    };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    let base = dir.trim_end_matches('/').to_string();
    let mut out = Vec::new();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(FileEntry {
            name: name.clone(),
            path: if base.is_empty() {
                name
            } else {
                format!("{base}/{name}")
            },
            is_dir,
        });
    }
    Ok(out)
}

/// 读取笔记内容。
#[tauri::command]
pub fn fs_read(vault: String, rel: String) -> Result<String, String> {
    let p = resolve_safe(&vault, &rel)?;
    std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))
}

/// 写入笔记内容（自动创建父目录）。原子写：临时文件 + rename，
/// 避免崩溃/断电留下截断文件、备份拷到写了一半的内容。
#[tauri::command]
pub fn fs_write(vault: String, rel: String, content: String) -> Result<(), String> {
    let p = resolve_safe(&vault, &rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = p.with_extension("md.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入失败: {e}"))?;
    crate::core::history::mark_dirty(&vault);
    Ok(())
}

/// 新建空笔记。原子写同 fs_write。
#[tauri::command]
pub fn fs_create(vault: String, rel: String) -> Result<(), String> {
    let p = resolve_safe(&vault, &rel)?;
    if p.exists() {
        return Err(format!("已存在: {rel}"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = p.with_extension("md.tmp");
    std::fs::write(&tmp, "").map_err(|e| format!("创建失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("创建失败: {e}"))?;
    crate::core::history::mark_dirty(&vault);
    Ok(())
}

/// 删除文件或目录（**进系统回收站**，可恢复）。
/// 保护：不能删 vault 根、不能删 notes/ 目录本身（笔记/清单/记录等
/// 都经由本命令删除，仅禁止"目录本体"级别的误删）。
#[tauri::command]
pub fn fs_delete(vault: String, rel: String) -> Result<(), String> {
    let p = resolve_safe(&vault, &rel)?;
    let root = PathBuf::from(&vault);
    let notes = root.join(NOTES_DIR);
    if p == root || p == notes {
        return Err(format!("不能删除目录本身: {rel}"));
    }
    trash::delete(&p).map_err(|e| format!("删除失败（移入回收站失败）: {e}"))?;
    crate::core::history::mark_dirty(&vault);
    Ok(())
}

/// 重命名 / 移动。目标已存在时拒绝（Windows rename 会静默覆盖，内容不可恢复）。
#[tauri::command]
pub fn fs_rename(vault: String, from: String, to: String) -> Result<(), String> {
    let a = resolve_safe(&vault, &from)?;
    let b = resolve_safe(&vault, &to)?;
    if b.exists() {
        return Err(format!("目标已存在: {to}"));
    }
    std::fs::rename(&a, &b).map_err(|e| format!("重命名失败: {e}"))?;
    crate::core::history::mark_dirty(&vault);
    Ok(())
}

/// 搜索笔记：转发到 FTS5 索引实现（`core::search`）。
/// 命令签名不变（vault, query → hits），前端无需改动。
#[tauri::command]
pub async fn fs_search(vault: String, query: String) -> Result<Vec<crate::core::search::SearchHit>, String> {
    crate::core::search::search(&vault, &query)
}

pub(crate) fn collect_md(root: &Path, dir: &Path, base: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let rel = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            collect_md(root, &entry.path(), &rel, out);
        } else if name.ends_with(".md") {
            out.push((rel, entry.path()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("toolbox-notes-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 旧布局迁移：vault 根下的 .md 应被移入 notes/，子目录（data 等）不受影响。
    #[test]
    fn migrates_root_md_into_notes() {
        let v = tmp_vault("migrate");
        std::fs::write(v.join("旧笔记.md"), "# 旧").unwrap();
        std::fs::create_dir_all(v.join("data")).unwrap();
        std::fs::write(v.join("data/keep.json"), "{}").unwrap();
        std::fs::write(v.join("data/keep.md"), "# 数据目录里的 md 不迁移").unwrap();

        let list = tauri::async_runtime::block_on(fs_list(v.to_string_lossy().to_string())).unwrap();
        // 根层 .md 已迁入 notes/，data 目录及其中的 md 不出现
        let paths: Vec<_> = list.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"notes/旧笔记.md"), "迁移后应位于 notes/: {paths:?}");
        assert!(!paths.iter().any(|p| p.contains("data")), "不应枚举 data 目录: {paths:?}");
        assert!(v.join("notes/旧笔记.md").exists(), "根层 md 应被移走");
        assert!(!v.join("旧笔记.md").exists());
        assert!(v.join("data/keep.md").exists(), "data 目录内容不动");
        // 返回的 name 是 notes/ 下的直接子项名（文件树顶层显示用）
        let entry = list.iter().find(|f| f.path == "notes/旧笔记.md").unwrap();
        assert_eq!(entry.name, "旧笔记.md");
        assert!(!entry.is_dir);

        std::fs::remove_dir_all(&v).ok();
    }

    /// 空 vault：fs_list 应创建 notes/ 并返回空列表。
    #[test]
    fn creates_empty_notes_dir() {
        let v = tmp_vault("empty");
        let list = tauri::async_runtime::block_on(fs_list(v.to_string_lossy().to_string())).unwrap();
        assert!(list.is_empty());
        assert!(v.join("notes").is_dir(), "notes/ 应被创建");

        std::fs::remove_dir_all(&v).ok();
    }

    /// 子文件夹内的 md 也要枚举，路径带 notes/ 前缀。
    #[test]
    fn lists_subfolders() {
        let v = tmp_vault("sub");
        std::fs::create_dir_all(v.join("notes/工作")).unwrap();
        std::fs::write(v.join("notes/工作/日报.md"), "# 日报").unwrap();
        std::fs::write(v.join("notes/顶层.md"), "# 顶层").unwrap();

        let list = tauri::async_runtime::block_on(fs_list(v.to_string_lossy().to_string())).unwrap();
        let paths: Vec<_> = list.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"notes/工作/日报.md"));
        assert!(paths.contains(&"notes/顶层.md"));
        assert!(paths.contains(&"notes/工作"));
        let dir = list.iter().find(|f| f.path == "notes/工作").unwrap();
        assert!(dir.is_dir);

        std::fs::remove_dir_all(&v).ok();
    }
}
