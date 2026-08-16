//! 笔记文件存储：vault/notes/ 下的 Markdown 操作。
//!
//! 由宿主 core/notes.rs 移植（同步化：插件命令是宿主进程内直接函数调用，
//! 无需 async IPC）。路径安全用 tb-sdk 的 resolve_safe（与宿主同实现）。

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tb_sdk::resolve_safe;

pub const IGNORED_DIRS: &[&str] = &[".git", ".toolbox", "node_modules", "target", "site"];
/// 笔记统一存放目录（vault/notes/）
pub const NOTES_DIR: &str = "notes";
/// 前端编辑器一次读取的最大字节数：超过则拒绝并提示用外部编辑器
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String, // vault 相对路径，/ 分隔
    pub is_dir: bool,
    /// 文件字节数（目录为 None）——前端可据此做超大文件提示
    pub size: Option<u64>,
}

/// 确保 notes/ 目录存在；首次使用时把旧布局（vault 根下的 .md）迁移进去。
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
/// 目录优先、按名排序。返回路径带 `notes/` 前缀（相对 vault）。
pub fn list(vault: &str) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(vault);
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
            out.push(FileEntry {
                name,
                path: rel.clone(),
                is_dir: true,
                size: None,
            });
            walk(root, &entry.path(), &rel, out);
        } else if name.ends_with(".md") {
            let size = entry.metadata().ok().map(|m| m.len());
            out.push(FileEntry {
                name,
                path: rel,
                is_dir: false,
                size,
            });
        }
    }
}

/// 列出 vault 内指定目录下的全部条目（不过滤扩展名，供 JSON 数据枚举）。
pub fn list_dir(vault: &str, dir: &str) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(vault);
    if !root.is_dir() {
        return Err(format!("工作区不存在: {vault}"));
    }
    let target = resolve_safe(vault, dir)?;
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
        let size = if is_dir {
            None
        } else {
            entry.metadata().ok().map(|m| m.len())
        };
        out.push(FileEntry {
            name: name.clone(),
            path: if base.is_empty() {
                name
            } else {
                format!("{base}/{name}")
            },
            is_dir,
            size,
        });
    }
    Ok(out)
}

/// 读取笔记内容。超大文件拒绝（防卡死），提示用外部编辑器。
pub fn read(vault: &str, rel: &str) -> Result<String, String> {
    let p = resolve_safe(vault, rel)?;
    let size = std::fs::metadata(&p)
        .map_err(|e| format!("读取失败: {e}"))?
        .len();
    if size > MAX_READ_BYTES {
        let mb = size as f64 / (1024.0 * 1024.0);
        return Err(format!("文件过大（{mb:.1} MB，上限 8 MB），请用外部编辑器打开"));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))
}

/// 写入笔记内容（自动创建父目录）。原子写：临时文件 + rename。
pub fn write(vault: &str, rel: &str, content: &str) -> Result<Value, String> {
    let p = resolve_safe(vault, rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = p.with_extension("md.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入失败: {e}"))?;
    Ok(Value::Null)
}

/// 新建空笔记。原子写同 write。
pub fn create(vault: &str, rel: &str) -> Result<Value, String> {
    let p = resolve_safe(vault, rel)?;
    if p.exists() {
        return Err(format!("已存在: {rel}"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = p.with_extension("md.tmp");
    std::fs::write(&tmp, "").map_err(|e| format!("创建失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("创建失败: {e}"))?;
    Ok(Value::Null)
}

/// 删除文件或目录（**进系统回收站**，可恢复）。
/// 保护：不能删 vault 根、不能删 notes/ 目录本身。
pub fn delete(vault: &str, rel: &str) -> Result<Value, String> {
    let p = resolve_safe(vault, rel)?;
    let root = PathBuf::from(vault);
    let notes = root.join(NOTES_DIR);
    if p == root || p == notes {
        return Err(format!("不能删除目录本身: {rel}"));
    }
    trash::delete(&p).map_err(|e| format!("删除失败（移入回收站失败）: {e}"))?;
    Ok(Value::Null)
}

/// 重命名 / 移动。目标已存在时拒绝（Windows rename 会静默覆盖）。
pub fn rename(vault: &str, from: &str, to: &str) -> Result<Value, String> {
    let a = resolve_safe(vault, from)?;
    let b = resolve_safe(vault, to)?;
    if b.exists() {
        return Err(format!("目标已存在: {to}"));
    }
    std::fs::rename(&a, &b).map_err(|e| format!("重命名失败: {e}"))?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb-notes-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn migrates_root_md_into_notes() {
        let v = tmp_vault("migrate");
        std::fs::write(v.join("旧笔记.md"), "# 旧").unwrap();
        std::fs::create_dir_all(v.join("data")).unwrap();
        std::fs::write(v.join("data/keep.json"), "{}").unwrap();
        std::fs::write(v.join("data/keep.md"), "# 数据目录里的 md 不迁移").unwrap();

        let list = list(v.to_str().unwrap()).unwrap();
        let paths: Vec<_> = list.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"notes/旧笔记.md"), "迁移后应位于 notes/: {paths:?}");
        assert!(!paths.iter().any(|p| p.contains("data")), "不应枚举 data 目录: {paths:?}");
        assert!(v.join("notes/旧笔记.md").exists(), "根层 md 应被移走");
        assert!(!v.join("旧笔记.md").exists());
        assert!(v.join("data/keep.md").exists(), "data 目录内容不动");
        let entry = list.iter().find(|f| f.path == "notes/旧笔记.md").unwrap();
        assert_eq!(entry.name, "旧笔记.md");
        assert!(!entry.is_dir);
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn creates_empty_notes_dir() {
        let v = tmp_vault("empty");
        let list = list(v.to_str().unwrap()).unwrap();
        assert!(list.is_empty());
        assert!(v.join("notes").is_dir(), "notes/ 应被创建");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn lists_subfolders() {
        let v = tmp_vault("sub");
        std::fs::create_dir_all(v.join("notes/工作")).unwrap();
        std::fs::write(v.join("notes/工作/日报.md"), "# 日报").unwrap();
        std::fs::write(v.join("notes/顶层.md"), "# 顶层").unwrap();

        let list = list(v.to_str().unwrap()).unwrap();
        let paths: Vec<_> = list.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"notes/工作/日报.md"));
        assert!(paths.contains(&"notes/顶层.md"));
        assert!(paths.contains(&"notes/工作"));
        let dir = list.iter().find(|f| f.path == "notes/工作").unwrap();
        assert!(dir.is_dir);
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn read_rejects_oversized_file() {
        let v = tmp_vault("big");
        std::fs::create_dir_all(v.join("notes")).unwrap();
        let big = vec![b'a'; (MAX_READ_BYTES + 1) as usize];
        std::fs::write(v.join("notes/big.md"), &big).unwrap();
        let err = read(v.to_str().unwrap(), "notes/big.md").unwrap_err();
        assert!(err.contains("文件过大"), "应提示文件过大: {err}");
        std::fs::write(v.join("notes/small.md"), "ok").unwrap();
        let ok = read(v.to_str().unwrap(), "notes/small.md").unwrap();
        assert_eq!(ok, "ok");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn crud_and_rename() {
        let v = tmp_vault("crud");
        let vault = v.to_str().unwrap();
        std::fs::create_dir_all(v.join("notes")).unwrap();
        write(vault, "notes/a.md", "# 你好").unwrap();
        assert_eq!(read(vault, "notes/a.md").unwrap(), "# 你好");
        create(vault, "notes/b.md").unwrap();
        assert!(create(vault, "notes/b.md").is_err(), "已存在应拒绝");
        rename(vault, "notes/a.md", "notes/c.md").unwrap();
        assert!(!v.join("notes/a.md").exists());
        assert!(v.join("notes/c.md").exists());
        assert!(rename(vault, "notes/c.md", "notes/b.md").is_err(), "目标已存在应拒绝");
        delete(vault, "notes/c.md").unwrap();
        assert!(!v.join("notes/c.md").exists());
        std::fs::remove_dir_all(&v).ok();
    }
}
