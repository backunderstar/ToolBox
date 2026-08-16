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

/// 读取当前工作区路径（供命令与后台任务复用）。
pub fn read_vault_path(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    let settings: VaultSettings =
        serde_json::from_str(&raw).map_err(|e| format!("解析配置失败: {e}"))?;
    Ok(settings.path)
}

/// 读取当前工作区路径（未设置过则返回默认）。
#[tauri::command]
pub fn vault_get(app: tauri::AppHandle) -> Result<VaultSettings, String> {
    Ok(VaultSettings {
        path: read_vault_path(&app)?,
    })
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
    // 原子写：临时文件 + rename。直接 fs::write 崩溃（断电/杀进程）会留下
    // 损坏的 JSON——读取端静默回退默认值，用户工作区设置丢失。
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存配置失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(())
}

/// 服务端校验：命令携带的 `vault` 参数必须等于已配置的工作区路径
/// （Windows 下大小写不敏感比较）。
///
/// **为什么需要**：vault 是所有文件类命令（搜索/备份/插件 fs）的作用域根。
/// 若完全信任前端传入的路径，任意第三方插件（或一次 XSS）都能把 vault 指向
/// 任意目录——`search_all` 变成"读取任意文件夹"原语，配合插件写命令可向
/// 任意已存在目录注入文件（如写启动目录实现持久化）。把 vault 绑定到
/// 设置页保存的唯一路径后，这些命令的作用域被限制在用户明确选择的工作区内。
pub fn ensure_vault_matches(app: &tauri::AppHandle, vault: &str) -> Result<(), String> {
    let configured = read_vault_path(app)?;
    let Some(configured) = configured else {
        return Err("工作区未设置，请先在设置中选择工作区".to_string());
    };
    let same = {
        #[cfg(target_os = "windows")]
        {
            configured.trim().to_lowercase() == vault.trim().to_lowercase()
        }
        #[cfg(not(target_os = "windows"))]
        {
            configured.trim() == vault.trim()
        }
    };
    if !same {
        return Err(format!(
            "工作区路径与已配置不一致（已配置: {configured}）—— 请重新选择工作区"
        ));
    }
    Ok(())
}
