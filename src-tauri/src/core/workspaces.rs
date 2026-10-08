//! 数据根目录模型（2026-09 用户重定义，取代早期"根下直接子目录=工作区"模型）：
//!
//! - **数据根目录（dataRoot）**：用户自定义的一个目录（如 `D:\ToolBoxData`），
//!   存放所有数据/文件；插件仍装全局插件目录、配置仍在 %APPDATA%（代码与数据分离）。
//! - 根下按约定组织大项：`Project/`（工作区）、`Plugin/`、`Config/`——**应用只管理
//!   Project/**，其余由用户自行组织。
//! - **工作区 = 数据根/Project/<名称>**（Project 下每个直接子文件夹）；日常选定
//!   工作区后，文件处理（搜索/备份/文件服务/插件）都作用于当前工作区。
//! - 每个工作区内自动维护隐藏目录 **`.toolbox`**：该工作区的标记 + 配置/信息存放处
//!   （宿主写搜索索引、备份、`workspace.json` 元数据；插件也可读写）。
//!
//! 配置存 `%APPDATA%/com.toolbox.desktop/root.json`：`{"root": "D:\\ToolBoxData"}`。
//! 未配置 root（首启）→ 前端进引导页；`current_workspace_path` 返回 None。
//! 旧 vault.json 不再读取（用户决策：不迁移，从零开始）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, Manager};

/// 数据根配置（root.json）：root = 数据根目录；current = 当前工作区名（Project 下）。
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RootSettings {
    pub root: Option<String>,
    #[serde(default)]
    pub current: Option<String>,
}

/// 工作区元数据（`.toolbox/workspace.json`；宿主自动维护，插件可读写）。
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMeta {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceItem {
    pub name: String,
    pub path: String,
    /// 目录 mtime（UNIX 毫秒）
    pub mtime: u64,
    /// `.toolbox/workspace.json` 元数据（无则 None）
    pub meta: Option<WorkspaceMeta>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: Option<String>,
    pub current: Option<String>,
    /// 当前生效工作区绝对路径（root/Project/current；未配置根 → None）
    pub vault: Option<String>,
    /// 根目录 Project/ 下的工作区列表
    pub items: Vec<WorkspaceItem>,
}

/// 数据根下的大项目录名（应用只管理 Project/）。
pub const PROJECTS_DIR: &str = "Project";
/// 数据根下的「文件输入」（Inbox）目录名：未知/待分类文件的暂存区
/// （与 Project/Plugin/Config 平级；工作区/插件可只读它，见输入视图与 TB_INBOX）。
pub const INPUTS_DIR: &str = "Input";
/// 工作区内的隐藏元数据目录（搜索索引/备份/描述；文件视图隐藏）。
pub const WS_META_DIR: &str = ".toolbox";
/// 工作区元数据文件名（.toolbox/workspace.json）。
const WS_META_FILE: &str = "workspace.json";

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("root.json"))
}

pub(crate) fn read_root(app: &tauri::AppHandle) -> Option<String> {
    let Ok(p) = settings_path(app) else {
        return None;
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<RootSettings>(&raw).ok())
        .and_then(|s| s.root)
}

/// Project/ 目录（数据根/Project；未配置根 → None）。
fn projects_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    read_root(app).map(|r| PathBuf::from(r).join(PROJECTS_DIR))
}

/// 当前生效工作区绝对路径：数据根/Project/<current>（未配置根/current → None）。
pub fn current_workspace_path(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(proj) = projects_dir(app) else {
        return Ok(None);
    };
    let current = read_settings(app);
    if let Some(cur) = current {
        let p = proj.join(cur);
        if p.is_dir() {
            return Ok(Some(p.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

/// 数据根下的「文件输入」（Inbox）目录绝对路径：数据根/Input。
/// 未配置数据根 → Err；目录不存在则自动创建（首次访问/设根时落地）。
pub fn input_dir_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = read_root(app).ok_or("未配置数据根目录（请先完成引导）")?;
    let d = PathBuf::from(root).join(INPUTS_DIR);
    std::fs::create_dir_all(&d).map_err(|e| format!("创建文件输入目录失败: {e}"))?;
    Ok(d)
}

/// 读取当前工作区名（root.json 之外的 current 状态仍存 root.json？——统一存 root.json）。
/// 简化：current 与 root 同文件（RootSettings 加 current 字段）。
fn read_settings(app: &tauri::AppHandle) -> Option<String> {
    let Ok(p) = settings_path(app) else {
        return None;
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<RootSettings>(&raw).ok())
        .and_then(|s| s.current)
}

/// 保存 root + current。
fn save_settings(app: &tauri::AppHandle, root: &str, current: Option<&str>) -> Result<(), String> {
    let p = settings_path(app)?;
    let raw = serde_json::to_string_pretty(&RootSettings {
        root: Some(root.to_string()),
        current: current.map(|s| s.to_string()),
    })
    .map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存配置失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存配置失败: {e}"))
}

/// 读取工作区元数据（.toolbox/workspace.json）。
fn read_ws_meta(ws: &std::path::Path) -> Option<WorkspaceMeta> {
    let p = ws.join(WS_META_DIR).join(WS_META_FILE);
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<WorkspaceMeta>(&raw).ok())
}

/// 自动维护工作区元数据：确保 `.toolbox/` 与 `workspace.json` 存在（不存在则创建）。
/// 宿主搜索索引/备份也写 .toolbox；此函数只保证"标记 + 元数据"落地。
pub(crate) fn ensure_ws_meta(ws: &std::path::Path) -> Result<(), String> {
    let meta_dir = ws.join(WS_META_DIR);
    std::fs::create_dir_all(&meta_dir).map_err(|e| format!("创建工作区元数据目录失败: {e}"))?;
    let file = meta_dir.join(WS_META_FILE);
    if file.exists() {
        return Ok(());
    }
    let name = ws
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();
    let meta = WorkspaceMeta {
        name,
        description: None,
        created_at: Some(now.clone()),
        updated_at: Some(now),
    };
    let raw = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(&file, &raw).map_err(|e| format!("写入工作区元数据失败: {e}"))
}

/// Project/ 下工作区列表（直接子目录，排除 `.` 开头；含 .toolbox 元数据）。
pub(crate) fn list_workspaces(proj: &std::path::Path) -> Vec<WorkspaceItem> {
    let mut items: Vec<WorkspaceItem> = Vec::new();
    let Ok(read) = std::fs::read_dir(proj) else {
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
            name: name.clone(),
            path: entry.path().to_string_lossy().to_string(),
            mtime,
            meta: read_ws_meta(&entry.path()),
        });
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items
}

fn info(app: &tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    let root = read_root(app);
    let current = read_settings(app);
    let items = match projects_dir(app) {
        Some(p) if p.is_dir() => list_workspaces(&p),
        _ => Vec::new(),
    };
    Ok(WorkspaceInfo {
        root,
        current,
        vault: current_workspace_path(app)?,
        items,
    })
}

/// 读取工作区信息（root / current / 生效路径 / Project 下工作区列表）。
/// root 未配置（首启）→ root=None，前端据此进引导页。
#[tauri::command]
pub fn workspace_get(app: tauri::AppHandle) -> Result<WorkspaceInfo, String> {
    info(&app)
}

/// 默认工作区名：数据根下 Project/ 为空时自动创建它。
/// 解决的问题（2026-09 用户实测的死路）：首次引导只让用户选"数据根"，Project/ 是新建的空目录
/// → `current` 为 None → 主界面照常进入但**没有任何工作区**：设置页「新建工作区」按钮被
/// `v-if="vault.state.path"` 挡住（要 path 才显示按钮，而 path 要有工作区才有）、探针卡分层的
/// 文件浏览报"未配置工作区"、Input 归位/files/搜索/备份全部不可用，且没有任何入口能补救。
/// 因此把"选根"这一步做成自洽的：根下没有工作区就地建一个并设为当前。
pub const DEFAULT_WORKSPACE: &str = "默认";

/// 数据根下的 Project/ 目录（不存在则创建），供选根/新建工作区复用。
fn ensure_projects_dir(dir: &std::path::Path) -> Result<PathBuf, String> {
    let proj = dir.join(PROJECTS_DIR);
    std::fs::create_dir_all(&proj).map_err(|e| format!("创建 Project/ 目录失败: {e}"))?;
    Ok(proj)
}

/// 工作区名校验（新建工作区用）：非空、不以 `.` 开头、不含路径分隔符与 Windows 非法字符。
fn validate_ws_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("工作区名称不能为空".to_string());
    }
    if name.starts_with('.') || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(format!("工作区名称含非法字符: {name}"));
    }
    Ok(name)
}

/// 在 Project/ 下创建并落地工作区（含 `.toolbox` 元数据）。已存在 → 报错（与 `workspace_create` 同语义）。
/// 只负责"建目录"，**不切换当前工作区**（切换由调用方 `save_settings` 决定）。
fn create_workspace_in(root: &str, name: &str) -> Result<(), String> {
    let name = validate_ws_name(name)?;
    let ws = PathBuf::from(root).join(PROJECTS_DIR).join(&name);
    if ws.exists() {
        return Err(format!("工作区已存在: {name}"));
    }
    std::fs::create_dir_all(&ws).map_err(|e| format!("创建工作区失败: {e}"))?;
    if let Err(e) = ensure_ws_meta(&ws) {
        crate::core::log::warn(&format!("[workspace] 元数据维护失败: {e}"));
    }
    Ok(())
}

/// 设置数据根目录：确保 Project/ 与 Input/ 存在；current 取第一个工作区，
/// **若 Project/ 下没有任何工作区则自动创建并选中 `DEFAULT_WORKSPACE`**（见该常量说明）。
/// 传空串 = 未实现清除（数据根是应用核心配置，不提供 UI 清除）。
#[tauri::command]
pub fn workspace_set_root(app: tauri::AppHandle, path: String) -> Result<WorkspaceInfo, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("路径不是有效文件夹: {path}"));
    }
    let proj = ensure_projects_dir(&dir)?;
    // 文件输入（Inbox）目录：数据根/Input（未知/待分类文件的暂存区）
    let input = dir.join(INPUTS_DIR);
    std::fs::create_dir_all(&input).map_err(|e| format!("创建 Input/ 目录失败: {e}"))?;
    let mut current = list_workspaces(&proj).into_iter().map(|i| i.name).next();
    if current.is_none() {
        // 空 Project/（全新数据根）或名字冲突（已有名为「默认」的文件而非目录）→ 退化为带序号的名字
        let mut name = DEFAULT_WORKSPACE.to_string();
        for seq in 2..100 {
            match create_workspace_in(&dir.to_string_lossy(), &name) {
                Ok(()) => {
                    current = Some(name.clone());
                    break;
                }
                Err(e) if e.starts_with("工作区已存在") => name = format!("{DEFAULT_WORKSPACE}{seq}"),
                Err(e) => return Err(e),
            }
        }
    }
    save_settings(&app, &dir.to_string_lossy(), current.as_deref())?;
    let _ = app.emit("workspace-changed", ());
    info(&app)
}

/// 切换当前工作区（name 必须是 数据根/Project/ 下的一个子目录名）。
/// 切换时自动维护该工作区的 .toolbox 元数据。
#[tauri::command]
pub fn workspace_switch(app: tauri::AppHandle, name: String) -> Result<WorkspaceInfo, String> {
    let Some(root) = read_root(&app) else {
        return Err("尚未配置数据根目录（请先完成引导）".to_string());
    };
    let ws = PathBuf::from(&root).join(PROJECTS_DIR).join(&name);
    if !ws.is_dir() {
        return Err(format!("工作区不存在: {name}（{ws:?}）"));
    }
    if let Err(e) = ensure_ws_meta(&ws) {
        crate::core::log::warn(&format!("[workspace] 元数据维护失败: {e}"));
    }
    save_settings(&app, &root, Some(&name))?;
    let _ = app.emit("workspace-changed", ());
    info(&app)
}

/// 新建工作区：在 数据根/Project/ 下创建文件夹（含 .toolbox 元数据）并切换为当前。
/// name 校验：非空、不以 `.` 开头、不含路径分隔符与 Windows 非法字符。
#[tauri::command]
pub fn workspace_create(app: tauri::AppHandle, name: String) -> Result<WorkspaceInfo, String> {
    let Some(root) = read_root(&app) else {
        return Err("尚未配置数据根目录（请先完成引导）".to_string());
    };
    let name = validate_ws_name(&name)?;
    create_workspace_in(&root, &name)?;
    save_settings(&app, &root, Some(&name))?;
    let _ = app.emit("workspace-changed", ());
    info(&app)
}

/* ---- 路径校验（搜索/备份/文件/插件命令的 scope 根）---- */

fn normalize(s: &str) -> String {
    s.trim()
        .trim_end_matches(['/', '\\'])
        .replace('\\', "/")
}

/// 服务端校验：命令携带的 `vault` 参数必须等于当前工作区路径
/// （数据根/Project/<current>；未配置根或未选中工作区 → 给出区分开的提示）。
pub fn ensure_workspace_matches(app: &tauri::AppHandle, vault: &str) -> Result<(), String> {
    let Some(cur) = current_workspace_path(app)? else {
        // 区分两种情形：数据根都没配 vs 配了根但没有当前工作区（后者曾误报"请先完成基础配置"，
        // 而用户其实已经配好了根——提示与实际不符，排查时被误导）。
        return Err(if read_root(app).is_none() {
            "未配置数据根目录，请先完成基础配置".to_string()
        } else {
            "未选择当前工作区（请在顶栏工作区按钮或设置页「新建/选择工作区」）".to_string()
        });
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
            "工作区路径与当前工作区不一致（当前: {cur}）—— 请切换到正确的工作区"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 数据根模型：Project/ 下直接子目录 = 工作区；隐藏目录/文件不算；
    /// 自动维护的 .toolbox/workspace.json 可被读取。
    #[test]
    fn list_workspaces_finds_project_dirs_and_meta() {
        let base = std::env::temp_dir().join(format!("tb-ws-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let proj = base.join("Project");
        std::fs::create_dir_all(proj.join("MG5")).unwrap();
        std::fs::create_dir_all(proj.join(".hidden")).unwrap();
        std::fs::write(proj.join("note.txt"), "x").unwrap();
        // 自动维护工作区元数据（.toolbox/workspace.json）
        ensure_ws_meta(&proj.join("MG5")).unwrap();
        assert!(proj.join("MG5/.toolbox/workspace.json").is_file());

        let items = list_workspaces(&proj);
        let names: Vec<&str> = items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["MG5"], "应只识别 Project 下子目录: {names:?}");
        assert!(items[0].meta.is_some(), "应读到 .toolbox 元数据");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 名字校验：空/`.` 开头/含分隔符与 Windows 非法字符都要拒绝（新建工作区与自动创建共用）。
    #[test]
    fn validate_ws_name_rejects_illegal() {
        assert!(validate_ws_name("  MG5  ").is_ok(), "合法名应通过并 trim");
        assert_eq!(validate_ws_name("  MG5  ").unwrap(), "MG5");
        for bad in ["", "   ", ".hidden", "a/b", "a\\b", "C:x", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b"] {
            assert!(validate_ws_name(bad).is_err(), "非法名应被拒绝: {bad:?}");
        }
    }

    /// 回归（用户实测死路）：数据根下 Project/ 为空时，**必须自动建一个工作区**，
    /// 否则 current 为 None → 主界面无工作区 → 设置页的「新建工作区」被 `v-if="path"` 挡住、
    /// 插件浏览报"未配置工作区"，而没有任何入口能补救。
    /// 这里直接测 `create_workspace_in` + `list_workspaces` 的组合语义（不依赖 AppHandle）。
    #[test]
    fn empty_project_gets_default_workspace() {
        let base = std::env::temp_dir().join(format!("tb-ws-default-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let proj = ensure_projects_dir(&base).unwrap();
        assert!(proj.is_dir(), "选根时应创建 Project/");

        // 模拟修复后的 workspace_set_root：空 Project/ → 建默认工作区
        let mut current = list_workspaces(&proj).into_iter().map(|i| i.name).next();
        assert!(current.is_none(), "前置：空 Project/ 应无工作区（这就是曾经的空窗）");
        if current.is_none() {
            create_workspace_in(&base.to_string_lossy(), DEFAULT_WORKSPACE).unwrap();
            current = list_workspaces(&proj).into_iter().map(|i| i.name).next();
        }
        assert_eq!(current.as_deref(), Some(DEFAULT_WORKSPACE), "应自动选中默认工作区");
        assert!(proj.join(DEFAULT_WORKSPACE).join(".toolbox/workspace.json").is_file(), "元数据应落地");

        // 已有工作区时不重复自动创建（选根只补空窗）
        let names: Vec<String> = list_workspaces(&proj).into_iter().map(|i| i.name).collect();
        assert_eq!(names, vec![DEFAULT_WORKSPACE.to_string()]);

        // 名字冲突（已有同名**文件**）→ 报"已存在"，由调用方退化为「默认2」
        let base2 = base.join("conflict");
        let proj2 = ensure_projects_dir(&base2).unwrap();
        std::fs::write(proj2.join(DEFAULT_WORKSPACE), "x").unwrap();
        let err = create_workspace_in(&base2.to_string_lossy(), DEFAULT_WORKSPACE).unwrap_err();
        assert!(err.starts_with("工作区已存在"), "冲突应报已存在: {err}");
        create_workspace_in(&base2.to_string_lossy(), &format!("{DEFAULT_WORKSPACE}2")).unwrap();
        assert_eq!(
            list_workspaces(&proj2).into_iter().map(|i| i.name).collect::<Vec<_>>(),
            vec![format!("{DEFAULT_WORKSPACE}2")],
            "退化名应可创建"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
