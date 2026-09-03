//! 文件输入（Inbox）管理：数据根/Input 下的未知/待分类文件暂存区。
//!
//! 职责（2026-09 用户需求）：
//! - 未知/待分类文件先放进 `数据根/Input`，后续再分类到各工作区；
//! - 工作区/插件**只读**该目录（process 插件经 `TB_INBOX`，native 插件经配置
//!   的 `input_dir`；见 plugins/process.rs 与 core-plugins/probe-rat-layer），
//!   本模块负责 Input 视图的列目录 / 导入（拖入）/ 归位（移入工作区）/ 删除 / 打开。
//!
//! 所有命令都只作用于 `数据根/Input`（宿主控制路径），无需 vault 作用域校验；
//! 归位目标 = 当前工作区（`current_workspace_path`，未配置则报错）。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Input 目录下单个条目的列表返回（列目录命令可复用于子目录导航）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputList {
    /// Input 目录绝对路径（当前浏览根）
    pub dir: String,
    pub entries: Vec<crate::core::files::FileEntry>,
}

/// Input 目录绝对路径（未配置数据根 → Err；目录不存在则自动创建）。
fn input_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::core::workspaces::input_dir_path(app)
}

/// 把 `name`（Input 下单个段，不允许绝对路径/`..`）解析为 Input 内绝对路径。
fn resolve_name(dir: &Path, name: &str) -> Result<PathBuf, String> {
    crate::core::path::resolve_relative(dir, name)
}

/// 目标路径已存在时追加 `_HHMMSS` 后缀避免覆盖（导入/归位共用）。
fn unique_target(parent: &Path, name: &str) -> PathBuf {
    let mut cand = parent.join(name);
    if !cand.exists() {
        return cand;
    }
    let ts = chrono::Local::now().format("%H%M%S");
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.to_string());
    let ext = p.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let new_name = if ext.is_empty() {
        format!("{stem}_{ts}")
    } else {
        format!("{stem}_{ts}.{ext}")
    };
    cand = parent.join(new_name);
    let mut i = 1;
    while cand.exists() {
        let suffix = if ext.is_empty() {
            format!("{stem}_{ts}_{i}")
        } else {
            format!("{stem}_{ts}_{i}.{ext}")
        };
        cand = parent.join(suffix);
        i += 1;
    }
    cand
}

/// 递归复制（导入跨卷回退用）。
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let e = entry?;
            copy_recursive(&e.path(), &dst.join(e.file_name()))?;
        }
    } else {
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

fn remove_any(p: &Path) -> Result<(), String> {
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format!("删除失败: {e}"))
    } else {
        std::fs::remove_file(p).map_err(|e| format!("删除失败: {e}"))
    }
}

/// 把 `src`（可能是外部路径）移入 `dst_parent`（Input 根）。跨卷 rename 失败时
/// 复制 + 删除源。返回最终文件名。
fn move_into(src: &Path, dst_parent: &Path) -> Result<String, String> {
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("无效源路径")?;
    if !src.exists() {
        return Err(format!("源不存在: {}", src.display()));
    }
    let dst = unique_target(dst_parent, &name);
    if std::fs::rename(src, &dst).is_err() {
        // 跨卷重命名失败（EXDEV）：复制 + 删除源
        if let Err(e) = copy_recursive(src, &dst) {
            return Err(format!("导入失败（跨卷复制）: {e}"));
        }
        remove_any(src)?;
    }
    Ok(dst.file_name().unwrap_or_default().to_string_lossy().to_string())
}

/// 列出 Input 目录（可导航子目录 `dir`，空 = Input 根；隐藏/忽略目录跳过）。
#[tauri::command]
pub fn input_list(app: AppHandle, dir: Option<String>) -> Result<InputList, String> {
    let root = input_dir(&app)?;
    let entries = crate::core::files::list(
        &root.to_string_lossy(),
        dir.as_deref().unwrap_or(""),
    )?;
    Ok(InputList {
        dir: root.to_string_lossy().to_string(),
        entries,
    })
}

/// 导入外部文件/文件夹到 Input（拖拽落点）。`paths` = 宿主收到的 OS 绝对路径，
/// 移动语义（同名冲突加时间戳；跨卷复制+删源）。
#[tauri::command]
pub fn input_import(app: AppHandle, paths: Vec<String>) -> Result<serde_json::Value, String> {
    let root = input_dir(&app)?;
    let mut imported = Vec::new();
    let mut errors = Vec::new();
    for p in &paths {
        match move_into(Path::new(p), &root) {
            Ok(name) => imported.push(name),
            Err(e) => errors.push(format!("{}: {e}", Path::new(p).display())),
        }
    }
    Ok(serde_json::json!({ "imported": imported, "errors": errors, "dir": root.to_string_lossy() }))
}

/// 把 Input 下选中项移入当前工作区（分类归位）。`names` = Input 下的文件/目录名。
#[tauri::command]
pub fn input_to_workspace(app: AppHandle, names: Vec<String>) -> Result<serde_json::Value, String> {
    let root = input_dir(&app)?;
    let Some(target) = crate::core::workspaces::current_workspace_path(&app)? else {
        return Err("未配置当前工作区（请先在顶栏/设置页选择或新建工作区）".to_string());
    };
    let target_dir = PathBuf::from(&target);
    let mut moved = Vec::new();
    let mut errors = Vec::new();
    for name in &names {
        let src = match resolve_name(&root, name) {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("{name}: {e}"));
                continue;
            }
        };
        if !src.exists() {
            errors.push(format!("{name}: 不存在或已移除"));
            continue;
        }
        match move_into(&src, &target_dir) {
            Ok(n) => moved.push(n),
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    Ok(serde_json::json!({ "moved": moved, "errors": errors, "target": target }))
}

/// 删除 Input 下选中项（进系统回收站，可恢复）。`names` = Input 下的文件名。
#[tauri::command]
pub fn input_delete(app: AppHandle, names: Vec<String>) -> Result<serde_json::Value, String> {
    let root = input_dir(&app)?;
    let mut deleted = Vec::new();
    let mut errors = Vec::new();
    for name in &names {
        let p = match resolve_name(&root, name) {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("{name}: {e}"));
                continue;
            }
        };
        if !p.exists() {
            errors.push(format!("{name}: 不存在或已移除"));
            continue;
        }
        match trash::delete(&p) {
            Ok(()) => deleted.push(name.clone()),
            Err(e) => errors.push(format!("{name}: 删除失败（{e}）")),
        }
    }
    Ok(serde_json::json!({ "deleted": deleted, "errors": errors }))
}

/// 在 Input 下新建子文件夹（自动创建父链；已存在拒绝）。`name` = 相对路径（可含 `/`）。
#[tauri::command]
pub fn input_mkdir(app: AppHandle, name: String) -> Result<(), String> {
    let root = input_dir(&app)?;
    let p = resolve_name(&root, &name)?;
    if p.exists() {
        return Err(format!("已存在: {name}"));
    }
    std::fs::create_dir_all(&p).map_err(|e| format!("创建目录失败: {e}"))
}

/// 重命名 Input 下某项（`from` → `to`，均为 Input 相对路径；目标已存在拒绝）。
#[tauri::command]
pub fn input_rename(app: AppHandle, from: String, to: String) -> Result<(), String> {
    let root = input_dir(&app)?;
    let a = resolve_name(&root, &from)?;
    let b = resolve_name(&root, &to)?;
    if b.exists() {
        return Err(format!("目标已存在: {to}"));
    }
    std::fs::rename(&a, &b).map_err(|e| format!("重命名失败: {e}"))
}

/// 系统默认应用打开 Input 下某项（`name` 空 = 打开 Input 目录本身）。
#[tauri::command]
pub fn input_open(app: AppHandle, name: Option<String>) -> Result<(), String> {
    let root = input_dir(&app)?;
    let p = match name.as_deref() {
        None | Some("") => root,
        Some(n) => resolve_name(&root, n)?,
    };
    if !p.exists() {
        return Err(format!("路径不存在: {}", p.display()));
    }
    tauri_plugin_opener::open_path(&p, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tb-input-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn unique_target_appends_timestamp() {
        let dir = tmp_dir("unique");
        std::fs::write(dir.join("a.txt"), "1").unwrap();
        let t = unique_target(&dir, "a.txt");
        assert_ne!(t.file_name().unwrap(), "a.txt");
        assert!(t.to_string_lossy().contains("a_"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn move_into_same_volume_renames() {
        let src_dir = tmp_dir("mvsrc");
        let dst_dir = tmp_dir("mvdst");
        std::fs::write(src_dir.join("f.txt"), "x").unwrap();
        let name = move_into(&src_dir.join("f.txt"), &dst_dir).unwrap();
        assert_eq!(name, "f.txt");
        assert!(dst_dir.join("f.txt").exists());
        assert!(!src_dir.join("f.txt").exists());
        let _ = std::fs::remove_dir_all(&src_dir);
        let _ = std::fs::remove_dir_all(&dst_dir);
    }

    #[test]
    fn resolve_name_rejects_escape() {
        let dir = tmp_dir("resolve");
        assert!(resolve_name(&dir, "../x").is_err());
        assert!(resolve_name(&dir, "C:/other").is_err());
        assert!(resolve_name(&dir, "a/b").is_ok()); // 允许子目录
        let _ = std::fs::remove_dir_all(&dir);
    }
}
