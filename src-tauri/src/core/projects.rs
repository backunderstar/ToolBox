//! 项目文件管理（M8）：`vault/projects/` 下的项目文件夹、归档与默认应用打开。
//!
//! - 项目 = 普通文件夹，无元数据文件；归档 = 移动到 `projects/archive/`
//! - 项目名严格校验（Windows 保留字符/越界），项目内路径经 `resolve_relative` 防越界
//! - 打开文件/文件夹走 `tauri-plugin-opener`（系统默认应用 / 资源管理器）

use crate::core::path::resolve_relative;
use serde::Serialize;
use std::path::{Path, PathBuf};

const PROJECTS_DIR: &str = "projects";
const ARCHIVE_DIR: &str = "archive";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub archived: bool,
    pub file_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub name: String,
    /// 相对项目根，`/` 分隔
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

/* ---------------- 校验与解析 ---------------- */

fn validate_project_name(name: &str) -> Result<(), String> {
    let t = name.trim();
    if t.is_empty() || t.len() > 128 {
        return Err(format!("项目名不合法: {name}"));
    }
    if t == "." || t == ".." || t.starts_with('.') {
        return Err(format!("项目名不合法: {name}"));
    }
    for ch in t.chars() {
        // Windows 文件系统保留字符 + 控制字符
        if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
            return Err(format!("项目名不合法: {name}"));
        }
    }
    Ok(())
}

fn projects_root(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(PROJECTS_DIR)
}

/// 项目绝对路径（active 或 archive 分支；不校验是否存在）。
fn project_path(vault: &str, name: &str, archived: bool) -> Result<PathBuf, String> {
    validate_project_name(name)?;
    let root = projects_root(vault);
    let dir = if archived {
        root.join(ARCHIVE_DIR)
    } else {
        root
    };
    Ok(dir.join(name.trim()))
}

/// 在 active / archive 中查找项目（前者优先），返回存在的绝对路径。
/// 与 `project_path` 一致，入口先过名校验：`find_project` 同时被
/// delete/files/open 使用，缺校验时 `name="../notes"` 可解析到 vault
/// 内任意目录（`projects_delete` 会物理删除它）。
fn find_project(vault: &str, name: &str) -> Result<PathBuf, String> {
    validate_project_name(name)?;
    let root = projects_root(vault);
    for archived in [false, true] {
        let dir = if archived {
            root.join(ARCHIVE_DIR)
        } else {
            root.clone()
        };
        let p = dir.join(name.trim());
        if p.is_dir() {
            return Ok(p);
        }
    }
    Err(format!("项目不存在: {}", name.trim()))
}

/// 目标目录下生成不重名路径：`name`、`name-2`、`name-3`…
fn unique_name(dir: &Path, name: &str) -> PathBuf {
    let mut dst = dir.join(name);
    let mut i = 2;
    while dst.exists() {
        dst = dir.join(format!("{name}-{i}"));
        i += 1;
    }
    dst
}

/// 递归统计目录内文件数。
fn count_files(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(read) = std::fs::read_dir(dir) {
        for e in read.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                n += count_files(&e.path());
            } else {
                n += 1;
            }
        }
    }
    n
}

/* ---------------- 命令 ---------------- */

/// 项目列表（进行中 + 已归档，各带文件数）。
#[tauri::command]
pub async fn projects_list(vault: String) -> Result<Vec<ProjectInfo>, String> {
    let root = projects_root(&vault);
    let mut out = Vec::new();
    let mut read_dir = |dir: &Path, archived: bool| {
        if let Ok(read) = std::fs::read_dir(dir) {
            for entry in read.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                // 归档目录本身不算项目
                if !archived && name == ARCHIVE_DIR {
                    continue;
                }
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    out.push(ProjectInfo {
                        name: name.clone(),
                        archived,
                        file_count: count_files(&entry.path()),
                    });
                }
            }
        }
    };
    read_dir(&root, false);
    read_dir(&root.join(ARCHIVE_DIR), true);
    out.sort_by(|a, b| (a.archived, &a.name).cmp(&(b.archived, &b.name)));
    Ok(out)
}

/// 创建项目文件夹 `projects/<name>/`。
#[tauri::command]
pub async fn projects_create(vault: String, name: String) -> Result<(), String> {
    validate_project_name(&name)?;
    let root = projects_root(&vault);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建 projects 目录失败: {e}"))?;
    let p = root.join(name.trim());
    if p.exists() {
        return Err(format!("项目已存在: {}", name.trim()));
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("创建项目失败: {e}"))?;
    Ok(())
}

/// 归档：`projects/<name>/` → `projects/archive/<name>/`（重名自动加 `-2` 后缀）。
#[tauri::command]
pub async fn projects_archive(vault: String, name: String) -> Result<(), String> {
    let src = project_path(&vault, &name, false)?;
    if !src.is_dir() {
        return Err(format!("项目不存在: {}", name.trim()));
    }
    let archive = projects_root(&vault).join(ARCHIVE_DIR);
    std::fs::create_dir_all(&archive).map_err(|e| format!("创建归档目录失败: {e}"))?;
    let dst = unique_name(&archive, name.trim());
    std::fs::rename(&src, &dst).map_err(|e| format!("归档失败: {e}"))?;
    Ok(())
}

/// 还原：`projects/archive/<name>/` → `projects/<name>/`。
#[tauri::command]
pub async fn projects_unarchive(vault: String, name: String) -> Result<(), String> {
    let src = project_path(&vault, &name, true)?;
    if !src.is_dir() {
        return Err(format!("项目不存在: {}", name.trim()));
    }
    let root = projects_root(&vault);
    let dst = unique_name(&root, name.trim());
    std::fs::rename(&src, &dst).map_err(|e| format!("还原失败: {e}"))?;
    Ok(())
}

/// 删除项目：默认进系统回收站；`permanent=true` 物理删除。
#[tauri::command]
pub async fn projects_delete(vault: String, name: String, permanent: bool) -> Result<(), String> {
    let target = find_project(&vault, &name)?;
    let res = if permanent {
        std::fs::remove_dir_all(&target).map_err(|e| format!("删除失败: {e}"))
    } else {
        trash::delete(&target).map_err(|e| format!("移入回收站失败: {e}"))
    };
    res?;
    Ok(())
}

/// 项目内文件列表（一层；`dir` 相对项目根，空串 = 项目根）。目录优先、按名排序。
#[tauri::command]
pub async fn projects_files(vault: String, name: String, dir: String) -> Result<Vec<ProjectFile>, String> {
    let proj = find_project(&vault, &name)?;
    let target = if dir.trim().is_empty() {
        proj
    } else {
        resolve_relative(&proj, &dir)?
    };
    if !target.is_dir() {
        return Err(format!("目录不存在: {dir}"));
    }
    let mut out = Vec::new();
    if let Ok(read) = std::fs::read_dir(&target) {
        for entry in read.flatten() {
            let fname = entry.file_name().to_string_lossy().to_string();
            if fname.starts_with('.') {
                continue;
            }
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let rel = if dir.trim().is_empty() {
                fname.clone()
            } else {
                format!("{}/{}", dir.trim_end_matches('/'), fname)
            };
            let size = if is_dir {
                None
            } else {
                entry.metadata().ok().map(|m| m.len())
            };
            out.push(ProjectFile { name: fname, path: rel, is_dir, size });
        }
    }
    // 目录优先（is_dir 降序），同类型按名称
    out.sort_by(|a, b| (b.is_dir, &b.name).cmp(&(a.is_dir, &a.name)));
    Ok(out)
}

/// 用系统默认应用打开项目内文件 / 资源管理器打开文件夹。
#[tauri::command]
pub async fn projects_open(vault: String, name: String, rel: String) -> Result<(), String> {
    let proj = find_project(&vault, &name)?;
    let target = if rel.trim().is_empty() {
        proj
    } else {
        resolve_relative(&proj, &rel)?
    };
    if !target.exists() {
        return Err(format!("路径不存在: {rel}"));
    }
    tauri_plugin_opener::open_path(target.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| format!("打开失败: {e}"))
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("toolbox-projects-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn name_validation() {
        for bad in ["", "  ", "..", ".", ".hidden", "a/b", "a\\b", "a:b", "a*b", "a?b", "\u{0}"] {
            assert!(validate_project_name(bad).is_err(), "应拒绝: {bad:?}");
        }
        for good in ["网站重构", "Project-A", "2025 年报 v2"] {
            assert!(validate_project_name(good).is_ok(), "应接受: {good:?}");
        }
    }

    #[test]
    fn create_and_list() {
        let v = tmp_vault("create");
        tauri::async_runtime::block_on(projects_create(
            v.to_string_lossy().to_string(),
            "网站重构".into(),
        ))
        .unwrap();
        let list = tauri::async_runtime::block_on(projects_list(v.to_string_lossy().to_string())).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "网站重构");
        assert!(!list[0].archived);
        assert_eq!(list[0].file_count, 0);

        // 重名拒绝
        let dup = tauri::async_runtime::block_on(projects_create(
            v.to_string_lossy().to_string(),
            "网站重构".into(),
        ));
        assert!(dup.is_err());

        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn archive_roundtrip() {
        let v = tmp_vault("archive");
        let vault = v.to_string_lossy().to_string();
        tauri::async_runtime::block_on(projects_create(vault.clone(), "A".into())).unwrap();
        std::fs::write(v.join("projects/A/note.txt"), "x").unwrap();

        tauri::async_runtime::block_on(projects_archive(vault.clone(), "A".into())).unwrap();
        assert!(v.join("projects/archive/A").is_dir());
        assert!(!v.join("projects/A").exists());
        let list = tauri::async_runtime::block_on(projects_list(vault.clone())).unwrap();
        assert!(list.iter().any(|p| p.archived && p.name == "A" && p.file_count == 1));
        // archive 目录本身不应作为进行中项目出现
        assert!(!list.iter().any(|p| !p.archived && p.name == ARCHIVE_DIR), "archive 目录不应列为项目: {list:?}");

        tauri::async_runtime::block_on(projects_unarchive(vault.clone(), "A".into())).unwrap();
        assert!(v.join("projects/A").is_dir());
        assert!(!v.join("projects/archive/A").exists());

        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn archive_name_collision() {
        let v = tmp_vault("collision");
        let vault = v.to_string_lossy().to_string();
        tauri::async_runtime::block_on(projects_create(vault.clone(), "B".into())).unwrap();
        tauri::async_runtime::block_on(projects_archive(vault.clone(), "B".into())).unwrap();
        // 再次创建同名 B 并归档 → 自动加 `-2` 后缀，不覆盖原归档
        tauri::async_runtime::block_on(projects_create(vault.clone(), "B".into())).unwrap();
        tauri::async_runtime::block_on(projects_archive(vault.clone(), "B".into())).unwrap();
        assert!(v.join("projects/archive/B").is_dir());
        assert!(v.join("projects/archive/B-2").is_dir(), "重名应加后缀");
        let list = tauri::async_runtime::block_on(projects_list(vault.clone())).unwrap();
        assert!(list.iter().any(|p| p.archived && p.name == "B-2"));

        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn path_escape_rejected() {
        let v = tmp_vault("escape");
        let vault = v.to_string_lossy().to_string();
        tauri::async_runtime::block_on(projects_create(vault.clone(), "P".into())).unwrap();
        for bad in ["..", "../x", "a/../../x", "/abs", "C:/x"] {
            let r = tauri::async_runtime::block_on(projects_files(
                vault.clone(),
                "P".into(),
                bad.into(),
            ));
            assert!(r.is_err(), "应拒绝 rel: {bad:?}");
        }
        std::fs::remove_dir_all(&v).ok();
    }

    /// 项目名注入：find_project（delete/files/open 共用）必须拒绝 `..`/路径分隔，
    /// 防止 `projects_delete("../../notes")` 物理删除 vault 内任意目录。
    #[test]
    fn find_project_rejects_name_escape() {
        let v = tmp_vault("find-escape");
        let vault = v.to_string_lossy().to_string();
        tauri::async_runtime::block_on(projects_create(vault.clone(), "P".into())).unwrap();
        // 造一个 vault 内的"诱饵"目录：若校验缺失，delete 会把它删掉
        std::fs::create_dir_all(v.join("notes")).unwrap();
        std::fs::write(v.join("notes/重要.md"), "# 数据").unwrap();

        for bad in ["..", "../notes", "./x", "a\\b", "P/../notes"] {
            let r = find_project(&vault, bad);
            assert!(r.is_err(), "find_project 应拒绝: {bad:?}");
        }
        // 正常项目仍可找到
        assert!(find_project(&vault, "P").is_ok());
        // 笔记目录完好
        assert!(v.join("notes/重要.md").exists());

        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn files_lists_dir() {
        let v = tmp_vault("files");
        let vault = v.to_string_lossy().to_string();
        tauri::async_runtime::block_on(projects_create(vault.clone(), "P".into())).unwrap();
        std::fs::create_dir_all(v.join("projects/P/子目录")).unwrap();
        std::fs::write(v.join("projects/P/a.txt"), "hello").unwrap();

        let files = tauri::async_runtime::block_on(projects_files(vault.clone(), "P".into(), "".into()))
            .unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0].is_dir && files[0].name == "子目录", "目录应排前面");
        let f = files.iter().find(|f| f.name == "a.txt").unwrap();
        assert_eq!(f.size, Some(5));

        let sub = tauri::async_runtime::block_on(projects_files(vault.clone(), "P".into(), "子目录".into()))
            .unwrap();
        assert!(sub.is_empty());

        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn delete_permanent() {
        let v = tmp_vault("delete");
        let vault = v.to_string_lossy().to_string();
        tauri::async_runtime::block_on(projects_create(vault.clone(), "D".into())).unwrap();
        tauri::async_runtime::block_on(projects_delete(vault.clone(), "D".into(), true)).unwrap();
        assert!(!v.join("projects/D").exists());
        std::fs::remove_dir_all(&v).ok();
    }
}
