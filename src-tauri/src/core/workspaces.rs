//! 多工作区（2026-09 用户需求）：一个"工作区根目录"下的多个项目文件夹，
//! 每个项目文件夹是一个工作区；应用有"当前工作区"，搜索/备份/文件服务/插件
//! 上下文都作用于当前工作区。
//!
//! 状态存 %APPDATA%/com.toolbox.desktop/workspaces.json：
//!   `{"root": "D:\\Projects", "current": "proj-a"}`
//! - 未设置 root（单工作区模式）→ 回退旧 vault.json 的 path（向后兼容）。
//! - root 下每个**直接子目录** = 一个工作区（排除 `.` 开头与文件）。
//!
//! 与 vault.rs 的关系：`current_workspace_path` 是"当前生效的 vault 路径"，
//! 即所有文件类命令（搜索/备份/文件服务）的 scope 根；vault.rs 的
//! `ensure_vault_matches` 委托本模块的 `ensure_workspace_matches`。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    pub root: Option<String>,
    pub current: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceItem {
    pub name: String,
    pub path: String,
    /// 目录 mtime（UNIX 毫秒；展示用）
    pub mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: Option<String>,
    pub current: Option<String>,
    /// 当前生效工作区绝对路径（root/current 或回退 vault.json）
    pub vault: Option<String>,
    /// 根目录下工作区列表（root 未设置时为空）
    pub items: Vec<WorkspaceItem>,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("workspaces.json"))
}

pub(crate) fn read_settings(app: &tauri::AppHandle) -> WorkspaceSettings {
    let Ok(p) = settings_path(app) else {
        return WorkspaceSettings::default();
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<WorkspaceSettings>(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_settings(app: &tauri::AppHandle, s: &WorkspaceSettings) -> Result<(), String> {
    let p = settings_path(app)?;
    let raw = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    // 原子写：临时文件 + rename（与 vault.rs 同款，防崩溃留损坏 JSON）
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存配置失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存配置失败: {e}"))
}

/// 当前生效的工作区绝对路径：
/// - root + current 都有 → root/current（多工作区模式）
/// - 否则 → 回退旧 vault.json（单工作区模式，向后兼容）
pub fn current_workspace_path(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let s = read_settings(app);
    if let (Some(root), Some(cur)) = (s.root, s.current) {
        let p = PathBuf::from(&root).join(&cur);
        if p.is_dir() {
            return Ok(Some(p.to_string_lossy().to_string()));
        }
    }
    super::vault::read_vault_path(app)
}

/// 根目录下工作区列表（直接子目录，排除 `.` 开头与文件，按名称排序）。
pub(crate) fn list_workspaces(root: &str) -> Vec<WorkspaceItem> {
    let mut items: Vec<WorkspaceItem> = Vec::new();
    let Ok(read) = std::fs::read_dir(root) else {
        return items;
    };
    for entry in read.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        items.push(WorkspaceItem {
            name,
            path: entry.path().to_string_lossy().to_string(),
            mtime,
        });
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items
}

fn info(app: &tauri::AppHandle, s: &WorkspaceSettings) -> Result<WorkspaceInfo, String> {
    let items = s.root.as_deref().map(list_workspaces).unwrap_or_default();
    Ok(WorkspaceInfo {
        root: s.root.clone(),
        current: s.current.clone(),
        vault: current_workspace_path(app)?,
        items,
    })
}

/// 读取当前工作区信息（root / current / 生效路径 / 根下列表）。
#[tauri::command]
pub fn workspace_get(app: tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    let s = read_settings(&app);
    info(&app, &s)
}

/// 设置工作区根目录：根下每个直接子目录成为一个工作区，current 自动取第一个
/// （无子目录则 current=None，回退单工作区模式）。传空串 = 清除 root（回退 vault）。
#[tauri::command]
pub fn workspace_set_root(app: tauri::AppHandle, path: String) -> Result<WorkspaceInfo, String> {
    let mut s = read_settings(&app);
    if path.trim().is_empty() {
        s.root = None;
        s.current = None;
        save_settings(&app, &s)?;
        let _ = app.emit("workspace-changed", ());
        return info(&app, &s);
    }
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("路径不是有效文件夹: {path}"));
    }
    s.root = Some(dir.to_string_lossy().to_string());
    s.current = s
        .root
        .clone()
        .as_deref()
        .map(list_workspaces)
        .unwrap_or_default()
        .into_iter()
        .map(|i| i.name)
        .next();
    save_settings(&app, &s)?;
    let _ = app.emit("workspace-changed", ());
    info(&app, &s)
}

/// 切换当前工作区（name 必须是根目录下的一个子目录名）。
#[tauri::command]
pub fn workspace_switch(app: tauri::AppHandle, name: String) -> Result<WorkspaceInfo, String> {
    let mut s = read_settings(&app);
    let Some(root) = s.root.clone() else {
        return Err("尚未设置工作区根目录".to_string());
    };
    let p = PathBuf::from(&root).join(&name);
    if !p.is_dir() {
        return Err(format!("工作区不存在: {name}（{p:?}）"));
    }
    s.current = Some(name);
    save_settings(&app, &s)?;
    let _ = app.emit("workspace-changed", ());
    info(&app, &s)
}

/* ---- 路径校验（搜索/备份/文件/插件命令的 scope 根，与 vault.rs 同源逻辑）---- */

fn normalize(s: &str) -> String {
    s.trim()
        .trim_end_matches(['/', '\\'])
        .replace('\\', "/")
}

/// 服务端校验：命令携带的 `vault` 参数必须等于当前生效工作区路径
/// （Windows 大小写不敏感）。多工作区模式下为 root/current；否则回退 vault.json。
/// 与旧 `ensure_vault_matches` 语义一致，防止前端/插件把文件类命令指向任意目录。
pub fn ensure_workspace_matches(app: &tauri::AppHandle, vault: &str) -> Result<(), String> {
    let Some(cur) = current_workspace_path(app)? else {
        return Err("工作区未设置，请先在设置中选择工作区".to_string());
    };
    let same = {
        #[cfg(target_os = "windows")]
        {
            normalize(&cur).to_lowercase() == normalize(vault).to_lowercase()
        }
        #[cfg(not(target_os = "windows"))]
        {
            normalize(&cur) == normalize(vault)
        }
    };
    if !same {
        return Err(format!(
            "工作区路径与当前工作区不一致（当前: {cur}）—— 请切换到正确的工作区或重新选择"
        ));
    }
    Ok(())
}
