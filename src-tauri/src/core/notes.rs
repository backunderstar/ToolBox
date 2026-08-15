//! 笔记文件操作：列表 / 读写 / 新建 / 删除 / 重命名 / 搜索。
//!
//! 所有路径均为 vault 相对路径（UI 统一用 `/` 分隔），
//! 由 `core::path::resolve_safe` 严格校验，防止越出工作区。

use crate::core::path::resolve_safe;
use serde::Serialize;
use std::path::{Path, PathBuf};

const IGNORED_DIRS: &[&str] = &[".git", ".toolbox", "node_modules", "target", "site"];
/// 笔记统一存放目录（vault/notes/），文件树与搜索都只作用于该目录
const NOTES_DIR: &str = "notes";
/// 全文搜索每文件最多读取的字节数（防止大文件拖垮搜索）
const SEARCH_READ_LIMIT: u64 = 256 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String, // vault 相对路径，/ 分隔
    pub is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub filename: String,
    pub snippet: String,
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

/// 写入笔记内容（自动创建父目录）。
#[tauri::command]
pub fn fs_write(vault: String, rel: String, content: String) -> Result<(), String> {
    let p = resolve_safe(&vault, &rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("写入失败: {e}"))
}

/// 新建空笔记。
#[tauri::command]
pub fn fs_create(vault: String, rel: String) -> Result<(), String> {
    let p = resolve_safe(&vault, &rel)?;
    if p.exists() {
        return Err(format!("已存在: {rel}"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    std::fs::write(&p, "").map_err(|e| format!("创建失败: {e}"))
}

/// 删除文件或目录。
#[tauri::command]
pub fn fs_delete(vault: String, rel: String) -> Result<(), String> {
    let p = resolve_safe(&vault, &rel)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("删除目录失败: {e}"))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("删除失败: {e}"))
    }
}

/// 重命名 / 移动。
#[tauri::command]
pub fn fs_rename(vault: String, from: String, to: String) -> Result<(), String> {
    let a = resolve_safe(&vault, &from)?;
    let b = resolve_safe(&vault, &to)?;
    std::fs::rename(&a, &b).map_err(|e| format!("重命名失败: {e}"))
}

/// 搜索笔记：仅扫描 notes/ 目录，文件名包含匹配优先，其次全文包含匹配（大小写不敏感）。
#[tauri::command]
pub async fn fs_search(vault: String, query: String) -> Result<Vec<SearchHit>, String> {
    let root = PathBuf::from(&vault);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let Ok(notes) = ensure_notes_dir(&root) else {
        return Ok(Vec::new());
    };
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_md(&notes, &notes, NOTES_DIR, &mut files);

    let mut hits = Vec::new();
    for (rel, abs) in files {
        let filename = abs
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if filename.to_lowercase().contains(&q) {
            hits.push(SearchHit {
                path: rel,
                filename,
                snippet: "文件名匹配".to_string(),
            });
            continue;
        }
        let Ok(f) = std::fs::File::open(&abs) else {
            continue;
        };
        use std::io::Read;
        let mut buf = Vec::new();
        let _ = f.take(SEARCH_READ_LIMIT).read_to_end(&mut buf);
        let content = String::from_utf8_lossy(&buf);
        let lower = content.to_lowercase();
        let Some(idx) = lower.find(&q) else {
            continue;
        };
        let start = idx.saturating_sub(30);
        let end = (idx + q.len() + 60).min(content.len());
        // 用原字符串的安全边界切片段，避免在非字符边界 panic
        let s = content.floor_char_boundary(start.min(content.len()));
        let e = content.floor_char_boundary(end.min(content.len()));
        let snippet = content
            .get(s..e)
            .unwrap_or("")
            .replace('\n', " ")
            .trim()
            .to_string();
        hits.push(SearchHit { path: rel, filename, snippet });
    }
    Ok(hits)
}

fn collect_md(root: &Path, dir: &Path, base: &str, out: &mut Vec<(String, PathBuf)>) {
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
