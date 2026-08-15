//! 插件清单（plugin.json）解析与校验。

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PluginRuntime {
    Webview,
    Process,
}

/// 插件清单。v1 字段：
/// - runtime = "webview"：entry 为 JS 文件相对路径，运行于界面内
/// - runtime = "process"：command 为启动命令（argv），如 ["python", "main.py"]
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub runtime: PluginRuntime,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub config: serde_json::Value,
}

/// v1 认识的权限（未知权限记录 warning，不阻止加载）。
pub const KNOWN_PERMISSIONS: &[&str] = &["fs:read:vault", "fs:write:vault", "log", "network"];

impl PluginManifest {
    pub fn validate(&self) -> Result<(), String> {
        let id_ok = !self.id.is_empty()
            && self
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok {
            return Err(format!(
                "插件 id 非法（仅允许小写字母/数字/连字符）: {:?}",
                self.id
            ));
        }
        if self.name.trim().is_empty() {
            return Err(format!("插件缺少 name: {}", self.id));
        }
        if self.version.trim().is_empty() {
            return Err(format!("插件缺少 version: {}", self.id));
        }
        match self.runtime {
            PluginRuntime::Webview => {
                if self.entry.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(format!(
                        "webview 插件缺少 entry（JS 入口）: {}",
                        self.id
                    ));
                }
            }
            PluginRuntime::Process => {
                let cmd = self.command.as_ref();
                if cmd.map(|c| c.is_empty()).unwrap_or(true) {
                    return Err(format!("process 插件缺少 command（启动命令）: {}", self.id));
                }
            }
        }
        for p in &self.permissions {
            if !KNOWN_PERMISSIONS.contains(&p.as_str()) {
                eprintln!(
                    "[plugin] 警告: {} 声明了未知权限 {:?}（忽略）",
                    self.id, p
                );
            }
        }
        Ok(())
    }
}
