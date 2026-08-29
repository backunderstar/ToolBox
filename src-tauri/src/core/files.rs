//! 宿主文件服务：vault 内文件的列表/读写/增删改（系统级框架能力）。
//!
//! 2026-08 迁回宿主本体：文件操作是插件系统（webview 桥 fs.readText/writeText、
//! process 核心 API fs.readText/writeText/listDir）与宿主数据层共同依赖的
//! **系统级横切能力**，不应挂在某个可装卸插件（原 core-notes）上——卸载该插件
//! 会连带断掉所有插件与宿主的文件能力。与 search/backup 迁回同构
//! （见 PLAN.md 阶段 7 决策：系统级横切能力不属于可装卸业务插件）。
//!
//! 纯函数在 `core::files`（可单测）；`#[tauri::command]` 在 `core::files_cmd`。
//! 命令全部做 S1c vault 作用域校验（`vault` 必须等于已配置工作区）。

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 枚举时忽略的目录（隐藏目录 / 工具目录 / 构建产物）。
pub const IGNORED_DIRS: &[&str] = &[".git", ".toolbox", "node_modules", "target", "site"];
/// 前端一次读取的最大字节数：超过拒绝并提示用外部编辑器（防卡死）。
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// vault 相对路径，`/` 分隔
    pub path: String,
    pub is_dir: bool,
    /// 文件字节数（目录为 None）——前端可据此做超大文件提示
    pub size: Option<u64>,
    /// 修改时间（UNIX 毫秒整数；搜索/排序用）
    pub mtime: Option<i64>,
}

/// 是否应跳过该条目（隐藏文件/忽略目录）。
fn should_ignore(name: &str, is_dir: bool) -> bool {
    name.starts_with('.') || (is_dir && IGNORED_DIRS.contains(&name))
}

/// 枚举 `dir`（vault 相对路径，空 = vault 根）下的**单层**条目，
/// 忽略隐藏/忽略目录，按 path 排序。与 process 插件核心 API `fs.listDir` 同构。
pub fn list(vault: &str, dir: &str) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(vault);
    if !root.is_dir() {
        return Err(format!("工作区不存在: {vault}"));
    }
    let p = if dir.trim().is_empty() {
        root.clone()
    } else {
        crate::core::path::resolve_safe(vault, dir)?
    };
    if !p.is_dir() {
        return Err(format!("目录不存在: {dir}"));
    }
    let Ok(read) = std::fs::read_dir(&p) else {
        return Ok(Vec::new());
    };
    let base = dir.trim().trim_end_matches('/');
    let mut out: Vec<FileEntry> = Vec::new();
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if should_ignore(&name, is_dir) {
            continue;
        }
        let rel = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        out.push(FileEntry {
            name,
            path: rel,
            is_dir,
            size: if is_dir {
                None
            } else {
                e.metadata().ok().map(|m| m.len())
            },
            mtime: e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64),
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// 读取文件内容。超大文件拒绝（防卡死），提示用外部编辑器。
pub fn read(vault: &str, rel: &str) -> Result<String, String> {
    let p = crate::core::path::resolve_safe(vault, rel)?;
    let size = std::fs::metadata(&p)
        .map_err(|e| format!("读取失败: {e}"))?
        .len();
    if size > MAX_READ_BYTES {
        let mb = size as f64 / (1024.0 * 1024.0);
        return Err(format!("文件过大（{mb:.1} MB，上限 8 MB），请用外部编辑器打开"));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读取失败: {e}"))
}

/// 写入文件内容（自动创建父目录）。原子写：临时文件 + rename（崩溃不留下半截文件）。
pub fn write(vault: &str, rel: &str, content: &str) -> Result<(), String> {
    let p = crate::core::path::resolve_safe(vault, rel)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("写入失败: {e}"))
}

/// 新建空文件（已存在拒绝）。原子写同 write。
pub fn create(vault: &str, rel: &str) -> Result<(), String> {
    let p = crate::core::path::resolve_safe(vault, rel)?;
    if p.exists() {
        return Err(format!("已存在: {rel}"));
    }
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, "").map_err(|e| format!("创建失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("创建失败: {e}"))
}

/// 删除文件或目录（**进系统回收站**，可恢复）。保护：不能删 vault 根。
pub fn delete(vault: &str, rel: &str) -> Result<(), String> {
    let p = crate::core::path::resolve_safe(vault, rel)?;
    if p == Path::new(vault) {
        return Err("不能删除工作区根目录".to_string());
    }
    trash::delete(&p).map_err(|e| format!("删除失败（移入回收站失败）: {e}"))
}

/// 重命名 / 移动。目标已存在时拒绝（Windows rename 会静默覆盖）。
pub fn rename(vault: &str, from: &str, to: &str) -> Result<(), String> {
    let a = crate::core::path::resolve_safe(vault, from)?;
    let b = crate::core::path::resolve_safe(vault, to)?;
    if b.exists() {
        return Err(format!("目标已存在: {to}"));
    }
    std::fs::rename(&a, &b).map_err(|e| format!("重命名失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb-files-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn crud_and_rename() {
        let v = tmp_vault("crud");
        let vault = v.to_str().unwrap();
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

    #[test]
    fn read_rejects_oversized_file() {
        let v = tmp_vault("big");
        let vault = v.to_str().unwrap();
        std::fs::create_dir_all(v.join("notes")).unwrap();
        let big = vec![b'a'; (MAX_READ_BYTES + 1) as usize];
        std::fs::write(v.join("notes/big.md"), &big).unwrap();
        let err = read(vault, "notes/big.md").unwrap_err();
        assert!(err.contains("文件过大"), "应提示文件过大: {err}");
        std::fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn list_ignores_hidden_and_ignored() {
        let v = tmp_vault("list");
        let vault = v.to_str().unwrap();
        std::fs::create_dir_all(v.join(".git")).unwrap();
        std::fs::write(v.join(".git/config"), "x").unwrap();
        std::fs::create_dir_all(v.join("target")).unwrap();
        std::fs::create_dir_all(v.join("notes")).unwrap();
        std::fs::write(v.join("notes/a.md"), "a").unwrap();
        std::fs::write(v.join(".hidden"), "h").unwrap();
        let entries = list(vault, "").unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["notes"], "应只列 notes（隐藏/忽略目录被跳过）: {names:?}");
        let sub = list(vault, "notes").unwrap();
        assert_eq!(sub[0].path, "notes/a.md");
        std::fs::remove_dir_all(&v).ok();
    }
}

/* ---------------- IPC 命令（全部做 S1c vault 作用域校验） ---------------- */

/// 文件命令的公共模式：校验 vault 是已配置工作区，再放行。
fn ensure_vault(app: &tauri::AppHandle, vault: &str) -> Result<(), String> {
    crate::core::vault::ensure_vault_matches(app, vault)
}

#[tauri::command]
pub fn files_list(
    app: tauri::AppHandle,
    vault: String,
    dir: Option<String>,
) -> Result<Vec<FileEntry>, String> {
    ensure_vault(&app, &vault)?;
    list(&vault, dir.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn files_read(app: tauri::AppHandle, vault: String, rel: String) -> Result<String, String> {
    ensure_vault(&app, &vault)?;
    read(&vault, &rel)
}

#[tauri::command]
pub fn files_write(
    app: tauri::AppHandle,
    vault: String,
    rel: String,
    content: String,
) -> Result<(), String> {
    ensure_vault(&app, &vault)?;
    write(&vault, &rel, &content)
}

#[tauri::command]
pub fn files_create(app: tauri::AppHandle, vault: String, rel: String) -> Result<(), String> {
    ensure_vault(&app, &vault)?;
    create(&vault, &rel)
}

#[tauri::command]
pub fn files_delete(app: tauri::AppHandle, vault: String, rel: String) -> Result<(), String> {
    ensure_vault(&app, &vault)?;
    delete(&vault, &rel)
}

#[tauri::command]
pub fn files_rename(
    app: tauri::AppHandle,
    vault: String,
    from: String,
    to: String,
) -> Result<(), String> {
    ensure_vault(&app, &vault)?;
    rename(&vault, &from, &to)
}
