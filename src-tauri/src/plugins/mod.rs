//! 插件系统：清单发现、注册表、生命周期（启用/禁用/热重载/崩溃重启）。

pub mod manifest;
pub mod process;

use manifest::{PluginManifest, PluginRuntime};
use process::ProcessPlugin;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;

/// 插件命令调用超时。
pub const API_TIMEOUT: Duration = Duration::from_secs(30);
/// 崩溃自动重启上限（窗口期内）。
const MAX_RESTARTS: u32 = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

pub struct PluginRecord {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    /// process 插件：init 握手后声明的命令；webview 插件由前端加载后补齐
    pub commands: Vec<String>,
    pub error: Option<String>,
    pub process: Option<ProcessPlugin>,
    pub restarts: u32,
    pub last_crash: Option<Instant>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub runtime: &'static str,
    /// webview 插件入口文件（相对插件目录），前端据此加载 JS
    pub entry: Option<String>,
    pub enabled: bool,
    pub status: &'static str,
    pub error: Option<String>,
    pub commands: Vec<String>,
}

pub struct PluginManager {
    pub vault: Option<PathBuf>,
    pub records: Vec<PluginRecord>,
    pub enabled: HashSet<String>,
}

impl Default for PluginManager {
    fn default() -> Self {
        Self {
            vault: None,
            records: Vec::new(),
            enabled: HashSet::new(),
        }
    }
}

/* ---------------- 启用状态持久化 (<vault>/.toolbox/plugins.json) ---------------- */

fn enabled_path(vault: &Path) -> PathBuf {
    vault.join(".toolbox").join("plugins.json")
}

fn load_enabled(vault: &Path) -> HashSet<String> {
    let Ok(raw) = std::fs::read_to_string(enabled_path(vault)) else {
        return HashSet::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return HashSet::new();
    };
    v.get("enabled")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn save_enabled(vault: &Path, enabled: &HashSet<String>) -> Result<(), String> {
    let p = enabled_path(vault);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let mut arr: Vec<String> = enabled.iter().cloned().collect();
    arr.sort();
    let raw = serde_json::to_string_pretty(&serde_json::json!({ "enabled": arr }))
        .map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| format!("保存启用状态失败: {e}"))
}

/* ---------------- 管理器 ---------------- */

impl PluginManager {
    /// 重新发现 `<vault>/plugins/*` 中的插件。
    /// 已启用且为 process 的插件自动启动；错误逐条记录不阻断其他插件。
    pub fn refresh(&mut self, vault: &Path) -> Result<(), String> {
        for rec in &mut self.records {
            if let Some(p) = rec.process.take() {
                p.shutdown();
            }
        }
        self.records.clear();
        self.vault = Some(vault.to_path_buf());
        self.enabled = load_enabled(vault);

        let plugins_dir = vault.join("plugins");
        if !plugins_dir.is_dir() {
            return Ok(());
        }
        let mut dirs: Vec<_> = match std::fs::read_dir(&plugins_dir) {
            Ok(r) => r.flatten().collect(),
            Err(_) => return Ok(()),
        };
        dirs.sort_by_key(|e| e.file_name());

        for entry in dirs {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let raw = match std::fs::read_to_string(dir.join("plugin.json")) {
                Ok(r) => r,
                Err(_) => continue, // 无清单的目录忽略
            };
            let manifest: PluginManifest = match serde_json::from_str(&raw) {
                Ok(m) => m,
                Err(e) => {
                    let id = dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    self.records.push(PluginRecord {
                        manifest: PluginManifest {
                            id: id.clone(),
                            name: id.clone(),
                            version: "?".into(),
                            runtime: PluginRuntime::Webview,
                            entry: None,
                            command: None,
                            permissions: vec![],
                            description: String::new(),
                            config: Value::Null,
                        },
                        dir,
                        commands: vec![],
                        error: Some(format!("plugin.json 解析失败: {e}")),
                        process: None,
                        restarts: 0,
                        last_crash: None,
                    });
                    continue;
                }
            };
            if let Err(e) = manifest.validate() {
                self.records.push(PluginRecord {
                    manifest,
                    dir,
                    commands: vec![],
                    error: Some(e),
                    process: None,
                    restarts: 0,
                    last_crash: None,
                });
                continue;
            }
            let id = manifest.id.clone();
            let is_enabled = self.enabled.contains(&id);
            let is_process = manifest.runtime == PluginRuntime::Process;
            let idx = self.records.len();
            self.records.push(PluginRecord {
                manifest,
                dir,
                commands: vec![],
                error: None,
                process: None,
                restarts: 0,
                last_crash: None,
            });
            if is_enabled && is_process {
                if let Err(e) = self.start_record(idx) {
                    self.records[idx].error = Some(e);
                }
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<PluginInfo> {
        self.records
            .iter()
            .map(|r| PluginInfo {
                id: r.manifest.id.clone(),
                name: r.manifest.name.clone(),
                version: r.manifest.version.clone(),
                description: r.manifest.description.clone(),
                runtime: match r.manifest.runtime {
                    PluginRuntime::Webview => "webview",
                    PluginRuntime::Process => "process",
                },
                entry: r.manifest.entry.clone(),
                enabled: self.enabled.contains(&r.manifest.id),
                status: if r.error.is_some() {
                    "error"
                } else if r.process.is_some() {
                    "ready"
                } else {
                    "stopped"
                },
                error: r.error.clone(),
                commands: r.commands.clone(),
            })
            .collect()
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), String> {
        let idx = self
            .records
            .iter()
            .position(|r| r.manifest.id == id)
            .ok_or("插件不存在")?;
        if enabled {
            self.enabled.insert(id.to_string());
            if self.records[idx].manifest.runtime == PluginRuntime::Process
                && self.records[idx].process.is_none()
            {
                if let Err(e) = self.start_record(idx) {
                    self.records[idx].error = Some(e.clone());
                    // 启动失败不算启用成功
                    self.enabled.remove(id);
                    return Err(e);
                }
            }
        } else {
            self.enabled.remove(id);
            self.stop_record(idx);
            self.records[idx].error = None;
        }
        if let Some(v) = &self.vault {
            save_enabled(v, &self.enabled)?;
        }
        Ok(())
    }

    /// 热重载：stop + start（process）；webview 插件由前端重新加载入口。
    pub fn reload(&mut self, id: &str) -> Result<(), String> {
        let idx = self
            .records
            .iter()
            .position(|r| r.manifest.id == id)
            .ok_or("插件不存在")?;
        self.stop_record(idx);
        self.records[idx].error = None;
        if self.enabled.contains(id)
            && self.records[idx].manifest.runtime == PluginRuntime::Process
        {
            self.start_record(idx)
                .map_err(|e| {
                    self.records[idx].error = Some(e.clone());
                    e
                })?;
        }
        Ok(())
    }

    /// 调用插件命令。进程插件：进程不在则先启动；崩溃类错误自动重启（限次）。
    pub fn invoke(&mut self, id: &str, command: &str, args: Value) -> Result<Value, String> {
        let idx = self
            .records
            .iter()
            .position(|r| r.manifest.id == id)
            .ok_or("插件不存在")?;
        if !self.enabled.contains(id) {
            return Err("插件未启用".to_string());
        }
        if self.records[idx].manifest.runtime != PluginRuntime::Process {
            return Err("webview 插件请由前端调用".to_string());
        }
        if self.records[idx].process.is_none() {
            self.start_record(idx)?;
        }
        // 只允许调用 init 握手时声明的命令（权限面收紧）
        if !self.records[idx].commands.iter().any(|c| c == command) {
            return Err(format!("插件未声明命令: {command}"));
        }
        let first = self.records[idx]
            .process
            .as_mut()
            .expect("process 已启动")
            .call(command, args.clone(), API_TIMEOUT);
        match first {
            Ok(v) => Ok(v),
            Err(e) => {
                let exited = self.records[idx]
                    .process
                    .as_mut()
                    .map(|p| p.has_exited())
                    .unwrap_or(false);
                // 进程退出（崩溃）或连续超时（挂死）都触发重启（限次）
                let timed_out = e.contains("超时");
                if (exited || timed_out) && self.may_restart(idx) {
                    self.stop_record(idx);
                    if let Err(se) = self.start_record(idx) {
                        self.records[idx].error = Some(se.clone());
                        return Err(se);
                    }
                    return self.records[idx]
                        .process
                        .as_mut()
                        .expect("重启后存在")
                        .call(command, args, API_TIMEOUT)
                        .map_err(|e2| format!("崩溃重启后仍失败: {e2}"));
                }
                if exited {
                    self.records[idx].error = Some("崩溃自动重启次数超限".into());
                } else if timed_out {
                    self.records[idx].error = Some("连续超时，已停止自动重启".into());
                }
                Err(e)
            }
        }
    }

    fn start_record(&mut self, idx: usize) -> Result<(), String> {
        let (id, cmd, perms) = {
            let rec = &self.records[idx];
            (
                rec.manifest.id.clone(),
                rec.manifest.command.clone(),
                rec.manifest.permissions.clone(),
            )
        };
        let cmd = cmd.ok_or("process 插件缺少 command")?;
        if cmd.is_empty() {
            return Err("process 插件 command 为空".to_string());
        }
        let dir = self.records[idx].dir.clone();
        let vault = self.vault.clone().ok_or("vault 未设置")?;
        let mut plugin =
            ProcessPlugin::spawn(&id, &cmd[0], &cmd[1..], &dir, &vault, perms)?;
        let commands = plugin.init(API_TIMEOUT)?;
        self.records[idx].commands = commands;
        self.records[idx].process = Some(plugin);
        self.records[idx].error = None;
        Ok(())
    }

    fn stop_record(&mut self, idx: usize) {
        if let Some(p) = self.records[idx].process.take() {
            p.shutdown();
        }
        self.records[idx].commands.clear();
    }

    fn may_restart(&mut self, idx: usize) -> bool {
        let now = Instant::now();
        let rec = &mut self.records[idx];
        if let Some(last) = rec.last_crash {
            if now.duration_since(last) > RESTART_WINDOW {
                rec.restarts = 0;
            }
        }
        if rec.restarts >= MAX_RESTARTS {
            return false;
        }
        rec.restarts += 1;
        rec.last_crash = Some(now);
        true
    }
}

/* ---------------- IPC 命令 ---------------- */

fn ensure_refreshed(m: &mut PluginManager, vault: &str) -> Result<(), String> {
    let v = PathBuf::from(vault);
    let changed = match &m.vault {
        Some(cur) => !paths_equal(cur, &v),
        None => true,
    };
    if changed {
        m.refresh(&v)?;
    }
    Ok(())
}

/// 路径比较：Windows 下大小写不敏感（避免用户传 C:/A 与 c:/a 导致反复刷新重启插件）。
#[cfg(target_os = "windows")]
fn paths_equal(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

#[cfg(not(target_os = "windows"))]
fn paths_equal(a: &Path, b: &Path) -> bool {
    a == b
}

#[tauri::command]
pub async fn plugins_list(
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
) -> Result<Vec<PluginInfo>, String> {
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &vault)?;
    Ok(m.list())
}

#[tauri::command]
pub async fn plugins_set_enabled(
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &vault)?;
    m.set_enabled(&id, enabled)
}

#[tauri::command]
pub async fn plugins_reload(
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
) -> Result<(), String> {
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &vault)?;
    m.reload(&id)
}

#[tauri::command]
pub async fn plugins_invoke(
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &vault)?;
    m.invoke(&id, &command, args)
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::Message;
    use serde_json::json;

    #[test]
    fn manifest_validation() {
        let ok: PluginManifest = serde_json::from_value(json!({
            "id": "csv-tool", "name": "CSV 工具", "version": "0.1.0",
            "runtime": "process", "command": ["python", "main.py"]
        }))
        .unwrap();
        assert!(ok.validate().is_ok());

        let bad_id: PluginManifest = serde_json::from_value(json!({
            "id": "Bad ID!", "name": "x", "version": "0.1.0",
            "runtime": "process", "command": ["python"]
        }))
        .unwrap();
        assert!(bad_id.validate().is_err());

        let missing_entry: PluginManifest = serde_json::from_value(json!({
            "id": "js-x", "name": "x", "version": "0.1.0", "runtime": "webview"
        }))
        .unwrap();
        assert!(missing_entry.validate().is_err());
    }

    #[test]
    fn rpc_message_roundtrip() {
        let req = Message::request(1, "call", json!({"command": "a", "args": {}}));
        let line = crate::rpc::encode(&req).unwrap();
        let parsed = crate::rpc::decode(line.trim()).unwrap();
        match parsed {
            Message::Request { id, method, params } => {
                assert_eq!(id, 1);
                assert_eq!(method, "call");
                assert!(params.is_some());
            }
            _ => panic!("应为 Request"),
        }
        let resp = Message::response_ok(2, json!({"ok": true}));
        let line = crate::rpc::encode(&resp).unwrap();
        match crate::rpc::decode(line.trim()).unwrap() {
            Message::Response { id, result, error } => {
                assert_eq!(id, 2);
                assert!(result.is_some());
                assert!(error.is_none());
            }
            _ => panic!("应为 Response"),
        }
    }

    /// 桥接回环：用仓库里的 csv-tool（真实 Python 进程）走完整 JSON-RPC。
    #[test]
    fn bridge_roundtrip_with_python() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let plugin_dir = base.join("plugins").join("csv-tool");
        let manifest_raw =
            std::fs::read_to_string(plugin_dir.join("plugin.json")).expect("示例插件应存在");
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        let cmd = m.command.clone().unwrap();
        let vault = std::env::temp_dir();
        let perms = m.permissions.clone();
        let mut p =
            ProcessPlugin::spawn(&m.id, &cmd[0], &cmd[1..], &plugin_dir, &vault, perms)
                .expect("应能启动 python 进程");
        let commands = p.init(Duration::from_secs(15)).unwrap();
        assert!(
            commands.contains(&"csv.convert".to_string()),
            "init 应返回 csv.convert"
        );

        let res = p
            .call(
                "csv.convert",
                json!({ "csv": "a,b\n1,2\n3,4", "format": "json" }),
                Duration::from_secs(15),
            )
            .unwrap();
        let text = res["text"].as_str().expect("结果应有 text");
        assert!(text.contains("\"a\": \"1\""), "JSON 转换结果: {text}");

        let res2 = p
            .call(
                "csv.convert",
                json!({ "csv": "a,b\n1,2", "format": "tsv" }),
                Duration::from_secs(15),
            )
            .unwrap();
        assert!(res2["text"].as_str().unwrap().contains("a\tb"));
        p.shutdown();
    }

    /// 错误路径：未知命令应返回插件错误（RPC error 透传）。
    #[test]
    fn bridge_error_path() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let plugin_dir = base.join("plugins").join("csv-tool");
        let manifest_raw =
            std::fs::read_to_string(plugin_dir.join("plugin.json")).expect("示例插件应存在");
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        let cmd = m.command.clone().unwrap();
        let vault = std::env::temp_dir();
        let perms = m.permissions.clone();
        let mut p =
            ProcessPlugin::spawn(&m.id, &cmd[0], &cmd[1..], &plugin_dir, &vault, perms).unwrap();
        p.init(Duration::from_secs(15)).unwrap();
        let err = p
            .call(
                "csv.no-such-command",
                json!({}),
                Duration::from_secs(15),
            )
            .unwrap_err();
        assert!(err.contains("未知命令") || err.contains("unknown"), "错误信息: {err}");
        p.shutdown();
    }

    /// 超时：插件无响应时应返回超时错误。
    #[test]
    fn bridge_timeout() {
        let vault = std::env::temp_dir();
        let mut p = ProcessPlugin::spawn(
            "sleepy",
            "python",
            &["-c".to_string(), "import time; time.sleep(5)".to_string()],
            &vault,
            &vault,
            vec![],
        )
        .expect("应能启动 python");
        let err = p.init(Duration::from_millis(800)).unwrap_err();
        assert!(err.contains("超时") || err.contains("timeout"), "错误信息: {err}");
        p.shutdown();
    }
}
