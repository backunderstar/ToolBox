//! Vault 工作区：文件夹路径的读取与持久化。
//!
//! 设置存放在系统应用配置目录（%APPDATA%/com.toolbox.desktop/vault.json），
//! 与 vault 内容分离——切换工作区不污染用户数据。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VaultSettings {
    pub path: Option<String>,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("vault.json"))
}

/// 读取当前工作区路径（未设置过则返回默认）。
#[tauri::command]
pub fn vault_get(app: tauri::AppHandle) -> Result<VaultSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(VaultSettings::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析配置失败: {e}"))
}

/// 设置工作区路径并持久化（校验必须是存在的文件夹）。
#[tauri::command]
pub fn vault_set(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("路径不是有效文件夹: {path}"));
    }
    let settings = VaultSettings { path: Some(path) };
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let p = settings_path(&app)?;
    std::fs::write(&p, raw).map_err(|e| format!("保存配置失败: {e}"))
}
