//! 配置导入导出（换机迁移）：前端 localStorage + 宿主配置合成单 JSON 文件。
//!
//! 导出范围：
//! - 前端 localStorage（theme / custom-themes / nav / layout，原样字符串，写回保真）
//! - 插件启停状态与已卸载核心插件（plugins.json 的 enabled/disabled/removed_core）
//! - 备份配置（backup.json，经既有钳制）
//! - AI 提供商（ai.json 的 baseUrl/model，**不含 API Key**——Key 在系统凭据管理器）
//!
//! 刻意排除：
//! - `plugins_dir`（自定义插件目录是机器相关路径，导入机不一定存在，导入时保留目标机现值）
//! - vault 数据本身（笔记/清单等是用户数据，走备份/手工迁移，不属于"配置"）
//!
//! 文件格式（version 1）：
//! ```json
//! { "format": "toolbox-config", "version": 1, "exportedAt", "appVersion",
//!   "frontend": { "<localStorage键>": "<原始字符串>", ... },
//!   "backend": { "pluginsEnabled": [...], "pluginsDisabled": [...],
//!                "removedCore": [...], "backup": {...}, "ai": {...} } }
//! ```

use serde_json::{json, Map, Value};
use std::path::PathBuf;
use tauri::Manager;

/// 配置包格式标识与版本（破坏性变更时 bump；导入按 version 校验）。
const FORMAT: &str = "toolbox-config";
const VERSION: u64 = 1;

/// 应用配置目录（%APPDATA%/com.toolbox.desktop；不存在则创建）。
fn app_config_dir(app: &tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 收集宿主侧（backend）配置。
fn collect_backend(app: &tauri::AppHandle, config_dir: &str) -> Map<String, Value> {
    let mut b = Map::new();
    // 插件启停 + 已卸载核心插件（plugins.json；plugins_dir 刻意不导出）
    let map = crate::plugins::manager::load_state_map(app);
    let arr = |k: &str| map.get(k).cloned().unwrap_or_else(|| Value::Array(vec![]));
    b.insert("pluginsEnabled".into(), arr("enabled"));
    b.insert("pluginsDisabled".into(), arr("disabled"));
    b.insert("removedCore".into(), arr("removed_core"));
    // 备份配置（backup.json）
    if let Ok(v) = serde_json::to_value(crate::core::backup::backup_config_get(config_dir)) {
        b.insert("backup".into(), v);
    }
    // AI 提供商（ai.json，无 Key；缺失 → Null，导入时跳过）
    let ai = std::fs::read_to_string(PathBuf::from(config_dir).join("ai.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or(Value::Null);
    b.insert("ai".into(), ai);
    b
}

/// 导出：合成配置包并原子写文件。返回导出内容 JSON（供前端展示大小/时间等）。
pub fn export_config(app: &tauri::AppHandle, path: &str, frontend: Value) -> Result<(), String> {
    let config_dir = app_config_dir(app)?;
    let bundle = json!({
        "format": FORMAT,
        "version": VERSION,
        "exportedAt": tb_sdk::now_iso(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "frontend": frontend,
        "backend": collect_backend(app, &config_dir),
    });
    atomic_write(path, bundle.to_string().as_bytes())
}

/// 导入：读取 + 校验 + 写回宿主配置；返回完整 bundle（前端据此写回 localStorage）。
pub fn import_config(app: &tauri::AppHandle, path: &str) -> Result<Value, String> {
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("读取配置文件失败: {e}"))?;
    let bundle: Value =
        serde_json::from_str(&raw).map_err(|e| format!("配置文件不是合法 JSON: {e}"))?;
    validate(&bundle)?;
    let config_dir = app_config_dir(app)?;
    apply_backend(app, &config_dir, bundle.get("backend"))?;
    Ok(bundle)
}

/* ---- Tauri 命令层（设置页「备份/恢复配置」按钮） ---- */

/// 导出配置到指定文件（前端传 localStorage 段，宿主合并自己的配置）。
#[tauri::command]
pub fn config_export(
    app: tauri::AppHandle,
    path: String,
    frontend: Value,
) -> Result<(), String> {
    export_config(&app, &path, frontend)
}

/// 导入配置：宿主侧已写回；返回完整配置包供前端写回 localStorage。
#[tauri::command]
pub fn config_import(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    import_config(&app, &path)
}

/// 结构校验：format/version 是硬门槛；backend 段存在则必须是对象
/// （字段级错误在 apply_backend 里处理，容错跳过而非整体拒绝）。
fn validate(bundle: &Value) -> Result<(), String> {
    if bundle.get("format").and_then(|v| v.as_str()) != Some(FORMAT) {
        return Err("不是 ToolBox 配置文件（缺 format 标识）".to_string());
    }
    if bundle.get("version").and_then(|v| v.as_u64()) != Some(VERSION) {
        return Err("配置文件版本不兼容（由更新版本的应用导出）".to_string());
    }
    if !bundle.get("frontend").map(|v| v.is_object()).unwrap_or(false) {
        return Err("配置文件缺 frontend 段".to_string());
    }
    if let Some(b) = bundle.get("backend") {
        if !b.is_object() {
            return Err("配置文件 backend 段格式错误".to_string());
        }
    }
    Ok(())
}

/// 写回宿主侧配置：
/// - plugins.json：只替换启停/已卸载集合，保留其余键（plugins_dir 等目标机现值）
/// - backup.json：反序列化失败则不写（保留目标机现有）
/// - ai.json：baseUrl/model 原子写（无 Key）
fn apply_backend(
    app: &tauri::AppHandle,
    config_dir: &str,
    backend: Option<&Value>,
) -> Result<(), String> {
    let Some(b) = backend else { return Ok(()) };
    let obj = b.as_object().ok_or("backend 段格式错误")?;

    // 字符串数组提取（类型不符/缺失 → 空数组，不报错）
    let str_arr = |key: &str| -> Vec<Value> {
        obj.get(key)
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|i| i.as_str().map(|s| Value::String(s.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut map = crate::plugins::manager::load_state_map(app);
    map.insert("enabled".into(), Value::Array(str_arr("pluginsEnabled")));
    map.insert("disabled".into(), Value::Array(str_arr("pluginsDisabled")));
    map.insert("removed_core".into(), Value::Array(str_arr("removedCore")));
    crate::plugins::manager::save_state_map(app, &map)?;

    if let Some(bv) = obj.get("backup") {
        if let Ok(cfg) = serde_json::from_value(bv.clone()) {
            crate::core::backup::backup_config_set(config_dir, cfg)?;
        }
    }

    if let Some(av) = obj.get("ai") {
        if av.is_object() {
            let path = PathBuf::from(config_dir).join("ai.json");
            let s = av.to_string();
            atomic_write(&path.to_string_lossy(), s.as_bytes())?;
        }
    }
    Ok(())
}

/// 原子写（临时文件 + rename，与其他配置文件一致；防崩溃留损坏 JSON）。
fn atomic_write(path: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("写入失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_accepts_wellformed() {
        let v = json!({
            "format": FORMAT, "version": VERSION,
            "frontend": { "toolbox.theme": "warm" },
            "backend": { "pluginsEnabled": ["core-example"] }
        });
        assert!(validate(&v).is_ok());
    }

    #[test]
    fn validate_rejects_bad_format_or_version() {
        assert!(validate(&json!({ "version": VERSION, "frontend": {} })).is_err());
        assert!(validate(&json!({ "format": FORMAT, "version": 999, "frontend": {} })).is_err());
        assert!(validate(&json!({ "format": FORMAT, "version": VERSION })).is_err());
        assert!(
            validate(&json!({ "format": FORMAT, "version": VERSION, "frontend": {}, "backend": [] }))
                .is_err()
        );
    }
}
