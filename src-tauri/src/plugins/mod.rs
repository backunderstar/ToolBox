//! 插件系统：清单发现、注册表、生命周期（启用/禁用/热重载/崩溃重启）。

pub mod events;
pub mod manifest;
pub mod native;
pub mod process;

use manifest::{NavDecl, PluginManifest, PluginRuntime};
use native::NativePlugin;
use process::ProcessPlugin;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, State};

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
    pub native: Option<NativePlugin>,
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
    /// 核心插件（native，随应用分发，不可卸载）
    pub builtin: bool,
    /// 搜索提供者（实现 search.provide 命令，启用后进入全局搜索）
    pub provider: bool,
    /// 系统插件（数据安全/横切能力，前端不可禁用）
    pub system: bool,
    /// 插件自带前端入口（相对插件目录；缺省用宿主内置视图组件）
    pub ui: Option<String>,
    /// 插件声明的导航入口（启用时并入侧边栏）
    pub nav: Vec<NavDecl>,
}

pub struct PluginManager {
    pub vault: Option<PathBuf>,
    pub records: Vec<PluginRecord>,
    /// 外部插件启用集合（`{"enabled": [...]}`）
    pub enabled: HashSet<String>,
    /// 核心插件（native）默认启用，显式禁用后记入此集合
    pub disabled: HashSet<String>,
    /// 应用配置目录（%APPDATA%/com.toolbox.desktop，refresh 时记录，插件配置用）
    pub config_dir: Option<String>,
    /// 最近一次扫描的 plugins 目录快照（目录名 + 有清单），
    /// 用于检测"目录增删但 vault 路径未变"的情况
    pub last_snapshot: Option<Vec<String>>,
}

impl Default for PluginManager {
    fn default() -> Self {
        Self {
            vault: None,
            records: Vec::new(),
            enabled: HashSet::new(),
            disabled: HashSet::new(),
            config_dir: None,
            last_snapshot: None,
        }
    }
}

/// plugins/ 目录内容快照：有 plugin.json 的目录名（排序）+ `_core` 容器下的
/// 子目录名（核心/手动安装插件）。任何增删/清单变化都会改变快照，从而触发
/// 重新发现——包括用户手动放入 _core 的 DLL 插件目录（_core 本身无 plugin.json，
/// 不含它的话新增子目录不会改变快照，导致"放进去刷新不识别"）。
fn plugins_snapshot(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter(|e| e.path().join("plugin.json").is_file())
                .filter_map(|e| e.file_name().to_string_lossy().into_owned().into())
                .collect()
        })
        .unwrap_or_default();
    let core = dir.join(CORE_DIR);
    if let Ok(rd) = std::fs::read_dir(&core) {
        let mut subs: Vec<String> = rd
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().to_string_lossy().into_owned().into())
            .collect();
        subs.sort();
        for s in subs {
            out.push(format!("{CORE_DIR}/{s}"));
        }
    }
    out.sort();
    out
}

/* ---------------- 全局插件目录与启用状态（%APPDATA%） ----------------
   插件是"工具/程序"，不属于某个工作区数据：统一装在应用配置目录
   （%APPDATA%/com.toolbox.desktop/plugins/），换工作区无需重装。
   启用状态同样全局（plugins.json 顶层 {enabled:[...]}）。
   兼容迁移：
   - 旧状态格式（按 vault 分键的 map）首次读取时并集迁移
   - 旧 vault/.toolbox/plugins.json 迁移进全局后删除
   - 旧 vault/plugins 目录中的插件自动复制到全局后整体进回收站 */

/// 全局插件根目录（%APPDATA%/com.toolbox.desktop/plugins/）。
fn global_plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    let p = dir.join("plugins");
    std::fs::create_dir_all(&p).map_err(|e| format!("创建插件目录失败: {e}"))?;
    Ok(p)
}

/// 核心插件子目录名（%APPDATA%/com.toolbox.desktop/plugins/_core/<id>/）。
/// 以下划线开头，与外部插件 id（仅小写字母/数字/连字符）不可能冲突。
pub const CORE_DIR: &str = "_core";

/// 打包版随应用分发核心插件：从资源目录（`resource_dir/resources/_core`，安装包内）
/// 部署到 `%APPDATA%/com.toolbox.desktop/plugins/_core`（清空后整体复制，
/// 保证与应用版本一致；核心插件是随应用分发的信任代码）。
/// 仅在**打包构建**（release，无 dev cfg）执行；dev 由 `pnpm build:core` 部署。
#[cfg(not(dev))]
pub fn ensure_core_plugins(app: &tauri::AppHandle) {
    let Ok(res) = app.path().resource_dir() else {
        return;
    };
    // bundle.resources 保留相对 tauri.conf.json 的路径（resources/_core）
    let src = res.join("resources").join(CORE_DIR);
    if !src.is_dir() {
        return;
    }
    let Ok(cfg) = app.path().app_config_dir() else {
        return;
    };
    let dst = cfg.join("plugins").join(CORE_DIR);
    let removed = load_removed_core(app);
    match deploy_core_plugins(&src, &dst, &removed) {
        Ok(()) => eprintln!("[plugin] 已部署随应用分发的核心插件到 {:?}", dst),
        Err(e) => eprintln!("[plugin] 核心插件资源部署失败: {e}"),
    }
}

/// 部署实现（可测）：**随包插件逐个覆盖部署**，不清空整个目标——
/// `_core` 下用户手动安装的本地 DLL 插件（非随包）保留，刷新后自动识别为原生插件。
/// 已卸载的核心插件（removed_core）跳过部署。
fn deploy_core_plugins(src: &Path, dst: &Path, removed: &HashSet<String>) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
    let read = std::fs::read_dir(src).map_err(|e| format!("读取资源目录失败 {src:?}: {e}"))?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.path().is_dir() || removed.contains(&name) {
            // 跳过已卸载的核心插件（用户卸载后保持卸载状态，不随应用重启恢复）
            continue;
        }
        let target = dst.join(&name);
        // 覆盖部署（先删旧目录再复制，避免残留已删除的文件）
        let _ = std::fs::remove_dir_all(&target);
        copy_dir_recursive(&entry.path(), &target)?;
    }
    Ok(())
}

/// 已卸载核心插件 id 集合（plugins.json 的 `removed_core` 键；随应用分发的
/// 核心插件被用户卸载后记录在此，部署与扫描跳过，直到重新安装）。
fn load_removed_core(app: &tauri::AppHandle) -> HashSet<String> {
    load_state_map(app)
        .get("removed_core")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn save_removed_core(app: &tauri::AppHandle, removed: &HashSet<String>) -> Result<(), String> {
    let mut map = load_state_map(app);
    let arr: Vec<Value> = removed
        .iter()
        .cloned()
        .map(Value::String)
        .collect();
    map.insert("removed_core".into(), Value::Array(arr));
    save_state_map(app, &map)
}

/// 核心插件资源源目录：优先打包资源（resource_dir/resources/_core，安装包内），
/// 其次 dev 源码 resources（src-tauri/resources/_core，由 build:core:release 生成）。
fn core_plugin_source(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("resources").join(CORE_DIR).join(id));
    }
    // dev：target/debug/toolbox.exe → 仓库根 → src-tauri/resources/_core/<id>
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push(p.join("src-tauri").join("resources").join(CORE_DIR).join(id));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_dir())
        .ok_or_else(|| {
            format!(
                "未找到核心插件资源: {id}（打包版应随应用分发；开发模式请先运行 pnpm build:core:release）"
            )
        })
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("plugins.json"))
}

fn load_state_map(app: &tauri::AppHandle) -> serde_json::Map<String, Value> {
    let Ok(p) = state_path(app) else {
        return serde_json::Map::new();
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn save_state_map(app: &tauri::AppHandle, map: &serde_json::Map<String, Value>) -> Result<(), String> {
    let p = state_path(app)?;
    let raw = serde_json::to_string_pretty(&Value::Object(map.clone())).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| format!("保存启用状态失败: {e}"))
}

/// 读取全局启用/禁用集合。新格式 `{"enabled": [...], "disabled": [...]}`；
/// 旧格式（按 vault 分键的 map）首次读取时并集迁移并重写。
fn load_state(app: &tauri::AppHandle) -> (HashSet<String>, HashSet<String>) {
    let map = load_state_map(app);
    let mut enabled = HashSet::new();
    let mut disabled = HashSet::new();
    if let Some(Value::Array(arr)) = map.get("enabled") {
        enabled = arr
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
    }
    if let Some(Value::Array(arr)) = map.get("disabled") {
        disabled = arr
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
    }
    // 旧格式（无 enabled 键）：所有 vault 键的数组并集（disabled 键除外）
    if !map.contains_key("enabled") {
        for (k, v) in &map {
            if k == "disabled" {
                continue;
            }
            if let Some(arr) = v.as_array() {
                for x in arr.iter().filter_map(|x| x.as_str()) {
                    enabled.insert(x.to_string());
                }
            }
        }
    }
    (enabled, disabled)
}

fn save_state(app: &tauri::AppHandle, enabled: &HashSet<String>, disabled: &HashSet<String>) -> Result<(), String> {
    let mut arr: Vec<String> = enabled.iter().cloned().collect();
    arr.sort();
    let mut dis: Vec<String> = disabled.iter().cloned().collect();
    dis.sort();
    let mut map = serde_json::Map::new();
    map.insert(
        "enabled".to_string(),
        Value::Array(arr.into_iter().map(Value::String).collect()),
    );
    map.insert(
        "disabled".to_string(),
        Value::Array(dis.into_iter().map(Value::String).collect()),
    );
    save_state_map(app, &map)
}

/// 旧版 vault/.toolbox/plugins.json（{enabled:[...]}）→ 全局并集迁移后删除。
fn migrate_legacy_enabled(app: &tauri::AppHandle, vault: &Path) {
    let legacy = vault.join(".toolbox").join("plugins.json");
    if !legacy.exists() {
        return;
    }
    if let Ok(raw) = std::fs::read_to_string(&legacy) {
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&raw) {
            if let Some(Value::Array(arr)) = obj.get("enabled") {
                let (mut enabled, disabled) = load_state(app);
                for x in arr.iter().filter_map(|x| x.as_str()) {
                    enabled.insert(x.to_string());
                }
                let _ = save_state(app, &enabled, &disabled);
            }
        }
    }
    let _ = std::fs::remove_file(&legacy);
}

/// 递归复制目录。
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败 {dst:?}: {e}"))?;
    let read = std::fs::read_dir(src).map_err(|e| format!("读取目录失败 {src:?}: {e}"))?;
    for entry in read.flatten() {
        let s = entry.path();
        let d = dst.join(entry.file_name());
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            copy_dir_recursive(&s, &d)?;
        } else {
            std::fs::copy(&s, &d).map_err(|e| format!("复制失败 {s:?}: {e}"))?;
        }
    }
    Ok(())
}

/// 迁移旧 vault/plugins/* → 全局目录；完成后 vault/plugins 整体进回收站。
/// 幂等：vault/plugins 不存在或已空时无事可做。返回迁移的插件数。
fn migrate_vault_plugins(vault: &Path, global: &Path) -> Result<usize, String> {
    let src = vault.join("plugins");
    if !src.is_dir() {
        return Ok(0);
    }
    let read = std::fs::read_dir(&src).map_err(|e| format!("读取 {src:?} 失败: {e}"))?;
    let mut migrated = 0usize;
    let mut has_plugin = false;
    for entry in read.flatten() {
        let dir = entry.path();
        if !dir.is_dir() || !dir.join("plugin.json").is_file() {
            continue;
        }
        has_plugin = true;
        let id = entry.file_name().to_string_lossy().to_string();
        let dst = global.join(&id);
        if dst.exists() {
            migrated += 1; // 全局已有同 id：保留全局版本
            continue;
        }
        copy_dir_recursive(&dir, &dst)?;
        migrated += 1;
    }
    // 有插件（或空目录）→ 整体进回收站，vault 保持纯净
    if has_plugin {
        let _ = trash::delete(&src);
    }
    Ok(migrated)
}

/* ---------------- 管理器 ---------------- */

impl PluginManager {
    /// 重新发现全局插件目录（%APPDATA%/com.toolbox.desktop/plugins/）中的插件；
    /// 同时执行旧布局迁移（vault/plugins → 全局，启用状态 → 全局）。
    /// 已启用且为 process 的插件自动启动；错误逐条记录不阻断其他插件。
    pub fn refresh(&mut self, app: &tauri::AppHandle, vault: &Path) -> Result<(), String> {
        for rec in &mut self.records {
            if let Some(p) = rec.process.take() {
                p.shutdown();
            }
        }
        self.records.clear();
        self.vault = Some(vault.to_path_buf());
        self.config_dir = app
            .path()
            .app_config_dir()
            .map(|d| d.to_string_lossy().to_string())
            .ok();
        // 旧版状态迁移（vault/.toolbox/plugins.json → 全局）后读全局启用集合
        migrate_legacy_enabled(app, vault);
        let (enabled, disabled) = load_state(app);
        self.enabled = enabled;
        self.disabled = disabled;

        // 旧布局迁移：vault/plugins/* → 全局目录（复制后回收站清理）
        let global = global_plugins_dir(app)?;
        if let Err(e) = migrate_vault_plugins(vault, &global) {
            eprintln!("[plugin] vault 插件迁移失败: {e}");
        }

        let plugins_dir = global;
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
            // 核心插件目录（_core/<id>/）：内部每个子目录是一个 native 插件
            if entry.file_name() == CORE_DIR {
                let mut subs: Vec<_> = match std::fs::read_dir(&dir) {
                    Ok(r) => r.flatten().collect(),
                    Err(_) => continue,
                };
                subs.sort_by_key(|e| e.file_name());
                for sub in subs {
                    if sub.path().is_dir() {
                        self.scan_plugin_dir(&sub.path());
                    }
                }
                continue;
            }
            self.scan_plugin_dir(&dir);
        }
        // 失效 id 清理：插件目录已删除后，enabled/disabled 里的残留 id
        // 会导致重新放回同名插件时自动启用（可能意外）。发现即移除并持久化。
        let valid: HashSet<String> = self.records.iter().map(|r| r.manifest.id.clone()).collect();
        let stale: Vec<String> = self
            .enabled
            .iter()
            .chain(self.disabled.iter())
            .filter(|id| !valid.contains(*id))
            .cloned()
            .collect();
        if !stale.is_empty() {
            for id in &stale {
                self.enabled.remove(id);
                self.disabled.remove(id);
            }
            save_state(app, &self.enabled, &self.disabled)?;
        }
        Ok(())
    }

    /// 插件是否启用：核心插件（native）默认启用，显式禁用后记入 disabled；
    /// 外部插件按 enabled 集合。
    fn plugin_enabled(&self, id: &str) -> bool {
        if self.disabled.contains(id) {
            return false;
        }
        let is_native = self
            .records
            .iter()
            .any(|r| r.manifest.id == id && r.manifest.runtime == PluginRuntime::Native);
        if is_native {
            true
        } else {
            self.enabled.contains(id)
        }
    }

    /// 扫描单个插件目录并入注册表；已启用则启动（process/native）。
    fn scan_plugin_dir(&mut self, dir: &Path) {
        let raw = match std::fs::read_to_string(dir.join("plugin.json")) {
            Ok(r) => r,
            Err(_) => return, // 无清单的目录忽略
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
                        search_provider: false,
                        system: false,
                        ui: None,
                        nav: vec![],
                    },
                    dir: dir.to_path_buf(),
                    commands: vec![],
                    error: Some(format!("plugin.json 解析失败: {e}")),
                    process: None,
                    native: None,
                    restarts: 0,
                    last_crash: None,
                });
                return;
            }
        };
        if let Err(e) = manifest.validate() {
            self.records.push(PluginRecord {
                manifest,
                dir: dir.to_path_buf(),
                commands: vec![],
                error: Some(e),
                process: None,
                native: None,
                restarts: 0,
                last_crash: None,
            });
            return;
        }
        let id = manifest.id.clone();
        // 启用判定（注意时序 bug，A6）：plugin_enabled 对 native 的判定依赖
        // self.records（`records.iter().any(runtime == Native)`），而本函数在
        // records.push **之前**调用它——首次扫描时 records 为空，native 会被
        // 当作外部插件（enabled.contains 为 false）→ 核心插件首次刷新不启动
        // （状态显示 enabled=true 但 stopped，直到某次 plugin_call 惰性启动）。
        // 这里对 native 特判：核心插件默认启用 = 不在 disabled 集合。
        let is_enabled = if manifest.runtime == PluginRuntime::Native {
            !self.disabled.contains(&id)
        } else {
            self.plugin_enabled(&id)
        };
        let idx = self.records.len();
        self.records.push(PluginRecord {
            manifest,
            dir: dir.to_path_buf(),
            commands: vec![],
            error: None,
            process: None,
            native: None,
            restarts: 0,
            last_crash: None,
        });
        if is_enabled {
            if let Err(e) = self.start_record(idx) {
                self.records[idx].error = Some(e);
            }
        }
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
                    PluginRuntime::Native => "native",
                },
                entry: r.manifest.entry.clone(),
                enabled: self.plugin_enabled(&r.manifest.id),
                // 状态语义：
                // - error 优先（清单/启动/崩溃等错误）
                // - process 插件：进程存活才算 ready
                // - native 插件：DLL 加载成功即 ready
                // - webview 插件：无子进程，入口由前端加载；
                //   启用即视为 ready（入口求值失败由前端 runtimeErrors 展示为错误）
                status: if r.error.is_some() {
                    "error"
                } else if r.manifest.runtime == PluginRuntime::Process {
                    if r.process.is_some() { "ready" } else { "stopped" }
                } else if r.manifest.runtime == PluginRuntime::Native {
                    if r.native.is_some() { "ready" } else { "stopped" }
                } else if self.plugin_enabled(&r.manifest.id) {
                    "ready"
                } else {
                    "stopped"
                },
                error: r.error.clone(),
                commands: r.commands.clone(),
                builtin: r.manifest.runtime == PluginRuntime::Native,
                provider: r.manifest.search_provider,
                system: r.manifest.system,
                ui: r.manifest.ui.as_ref().map(|u| u.entry.clone()),
                nav: r.manifest.nav.clone(),
            })
            .collect()
    }

    pub fn set_enabled(&mut self, app: &tauri::AppHandle, id: &str, enabled: bool) -> Result<(), String> {
        let idx = self
            .records
            .iter()
            .position(|r| r.manifest.id == id)
            .ok_or("插件不存在")?;
        if !enabled && self.records[idx].manifest.system {
            return Err("系统插件不可禁用（数据安全/横切能力）".to_string());
        }
        // 核心插件（native）默认启用：禁用记入 disabled，重新启用移除
        let is_native = self.records[idx].manifest.runtime == PluginRuntime::Native;
        if enabled {
            if is_native {
                self.disabled.remove(id);
            } else {
                self.enabled.insert(id.to_string());
            }
            // webview 插件由前端加载入口，无后端进程/库需要启动
            let need_start = match self.records[idx].manifest.runtime {
                PluginRuntime::Webview => false,
                PluginRuntime::Process => self.records[idx].process.is_none(),
                PluginRuntime::Native => self.records[idx].native.is_none(),
            };
            if need_start {
                if let Err(e) = self.start_record(idx) {
                    self.records[idx].error = Some(e.clone());
                    // 启动失败不算启用成功
                    if is_native {
                        self.disabled.insert(id.to_string());
                    } else {
                        self.enabled.remove(id);
                    }
                    return Err(e);
                }
            }
        } else {
            if is_native {
                self.disabled.insert(id.to_string());
            } else {
                self.enabled.remove(id);
            }
            self.stop_record(idx);
            self.records[idx].error = None;
        }
        save_state(app, &self.enabled, &self.disabled)?;
        Ok(())
    }

    /// 卸载插件：停进程 + 清启用状态 + 删除插件目录。
    /// - 外部插件：目录移入回收站（可恢复，无资源可还原）。
    /// - 核心插件（native，随应用分发）：**真实卸载**——DLL/目录物理删除
    ///   （不可回收），并记录到 removed_core，防止下次启动从随应用分发的
    ///   资源重新部署；需要时经 plugins_reinstall_core 从资源一键恢复。
    /// - 手动安装的 native 插件（_core 下、无随包资源）：物理删除即可，
    ///   不记 removed_core（部署逻辑不清空 _core，不会复活）。
    pub fn uninstall(&mut self, app: &tauri::AppHandle, id: &str) -> Result<(), String> {
        let idx = self
            .records
            .iter()
            .position(|r| r.manifest.id == id)
            .ok_or("插件不存在")?;
        let is_native = self.records[idx].manifest.runtime == PluginRuntime::Native;
        let dir = self.records[idx].dir.clone();
        self.stop_record(idx);
        self.records.remove(idx);
        self.enabled.remove(id);
        self.disabled.remove(id);
        save_state(app, &self.enabled, &self.disabled)?;
        if is_native {
            // 随包核心插件：记录"已卸载"，防止启动时重新部署
            if core_plugin_source(app, id).is_ok() {
                let mut removed = load_removed_core(app);
                removed.insert(id.to_string());
                save_removed_core(app, &removed)?;
            }
            // 真实卸载：DLL/目录物理删除（随包插件可从资源恢复，手动安装的不可恢复）
            std::fs::remove_dir_all(&dir).map_err(|e| format!("删除插件目录失败: {e}"))?;
        } else {
            trash::delete(&dir).map_err(|e| format!("删除插件目录失败: {e}"))?;
        }
        Ok(())
    }

    /// 界面安装 DLL 插件（用户选择的 .zip 包或插件目录）：
    /// 解包/复制到临时目录 → 定位 plugin.json 校验（native + command + id）→
    /// 部署到 _core/<id> → 扫描并启用启动。zip 解压带 zip-slip 防护。
    pub fn install_native(
        &mut self,
        app: &tauri::AppHandle,
        source: &str,
        kind: &str,
    ) -> Result<String, String> {
        if kind != "zip" && kind != "dir" {
            return Err(format!("未知安装来源: {kind}"));
        }
        let cfg = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("定位配置目录失败: {e}"))?;
        let core_root = cfg.join("plugins").join(CORE_DIR);
        std::fs::create_dir_all(&core_root).map_err(|e| format!("创建插件目录失败: {e}"))?;
        let tmp = cfg
            .join("plugins")
            .join(format!(".install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败: {e}"))?;

        // 1. 解包到临时目录
        let unpack = || -> Result<(), String> {
            if kind == "zip" {
                let file =
                    std::fs::File::open(source).map_err(|e| format!("打开插件包失败: {e}"))?;
                let mut zip =
                    zip::ZipArchive::new(file).map_err(|e| format!("解析插件包失败: {e}"))?;
                for i in 0..zip.len() {
                    let mut entry = zip
                        .by_index(i)
                        .map_err(|e| format!("读取插件包条目失败: {e}"))?;
                    // zip-slip 防护：拒绝 ../ 等越界路径
                    let Some(rel) = entry.enclosed_name() else {
                        return Err("插件包包含非法路径（拒绝越界解压）".into());
                    };
                    let out = tmp.join(&rel);
                    if entry.is_dir() {
                        std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败: {e}"))?;
                    } else {
                        if let Some(p) = out.parent() {
                            std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败: {e}"))?;
                        }
                        let mut f =
                            std::fs::File::create(&out).map_err(|e| format!("写入失败: {e}"))?;
                        std::io::copy(&mut entry, &mut f).map_err(|e| format!("解压失败: {e}"))?;
                    }
                }
                Ok(())
            } else {
                copy_dir_recursive(Path::new(source), &tmp)
            }
        };
        unpack().map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp);
            e
        })?;

        // 2. 定位 plugin.json（根或唯一子目录——常见打包结构 <id>/plugin.json）
        let (manifest_dir, manifest) = find_plugin_manifest(&tmp).map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp);
            e
        })?;
        let bad = |e: String| {
            let _ = std::fs::remove_dir_all(&tmp);
            e
        };
        if manifest.runtime != PluginRuntime::Native {
            return Err(bad(format!(
                "仅支持安装 native（DLL）插件（清单 runtime 为其他类型）: {}",
                manifest.id
            )));
        }
        if manifest
            .command
            .as_ref()
            .map(|c| c.is_empty())
            .unwrap_or(true)
        {
            return Err(bad(format!(
                "native 插件清单缺少 command（DLL 文件名）: {}",
                manifest.id
            )));
        }
        if !is_safe_plugin_id(&manifest.id) {
            return Err(bad(format!("非法插件 id: {}", manifest.id)));
        }
        let id = manifest.id.clone();
        let dst = core_root.join(&id);
        if dst.exists() {
            return Err(bad(format!(
                "插件已存在: {id}（如需重装请先卸载）"
            )));
        }
        copy_dir_recursive(&manifest_dir, &dst).map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp);
            e
        })?;
        let _ = std::fs::remove_dir_all(&tmp);

        // 3. 扫描 + 默认启用 + 启动
        self.scan_plugin_dir(&dst);
        self.enabled.insert(id.clone());
        self.disabled.remove(&id);
        save_state(app, &self.enabled, &self.disabled)?;
        if let Some(idx) = self.records.iter().position(|r| r.manifest.id == id) {
            if self.plugin_enabled(&id) {
                self.start_record(idx).map_err(|e| {
                    self.records[idx].error = Some(e.clone());
                    e
                })?;
            }
        }
        Ok(id)
    }

    /// 重新安装已卸载的核心插件：从随应用分发的资源恢复目录 + 清"已卸载"标记 + 启用并启动。
    pub fn reinstall_core(&mut self, app: &tauri::AppHandle, id: &str) -> Result<(), String> {
        if !is_safe_plugin_id(id) {
            return Err(format!("非法插件 id: {id}"));
        }
        let src = core_plugin_source(app, id)?;
        let cfg = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("定位配置目录失败: {e}"))?;
        let dst = cfg.join("plugins").join(CORE_DIR).join(id);
        if dst.exists() {
            return Err(format!("插件已存在: {id}（如需重装请先卸载）"));
        }
        std::fs::create_dir_all(&dst)
            .map_err(|e| format!("创建插件目录失败: {e}"))?;
        copy_dir_recursive(&src, &dst)?;
        // 清"已卸载"标记 + 默认启用
        let mut removed = load_removed_core(app);
        removed.remove(id);
        save_removed_core(app, &removed)?;
        self.enabled.insert(id.to_string());
        self.disabled.remove(id);
        save_state(app, &self.enabled, &self.disabled)?;
        // 扫描并启动
        self.scan_plugin_dir(&dst);
        if let Some(idx) = self.records.iter().position(|r| r.manifest.id == id) {
            if self.plugin_enabled(id) {
                self.start_record(idx).map_err(|e| {
                    self.records[idx].error = Some(e.clone());
                    e
                })?;
            }
        }
        Ok(())
    }

    /// 热重载：stop + start（process/native）；webview 插件由前端重新加载入口。
    pub fn reload(&mut self, id: &str) -> Result<(), String> {
        let idx = self
            .records
            .iter()
            .position(|r| r.manifest.id == id)
            .ok_or("插件不存在")?;
        self.stop_record(idx);
        self.records[idx].error = None;
        if self.plugin_enabled(id) && self.records[idx].manifest.runtime != PluginRuntime::Webview
        {
            self.start_record(idx)
                .map_err(|e| {
                    self.records[idx].error = Some(e.clone());
                    e
                })?;
        }
        Ok(())
    }

    /// 调用插件命令（统一路由）：
    /// - native：宿主进程内 FFI（最高性能）
    /// - process：JSON-RPC over stdio（进程隔离）
    /// - webview：由前端调用（这里拒绝）
    pub fn invoke(&mut self, id: &str, command: &str, args: Value) -> Result<Value, String> {
        let idx = self
            .records
            .iter()
            .position(|r| r.manifest.id == id)
            .ok_or("插件不存在")?;
        if !self.plugin_enabled(id) {
            return Err("插件未启用".to_string());
        }
        match self.records[idx].manifest.runtime {
            PluginRuntime::Webview => Err("webview 插件请由前端调用".to_string()),
            PluginRuntime::Process => self.invoke_process(idx, command, args),
            PluginRuntime::Native => {
                if self.records[idx].native.is_none() {
                    self.start_record(idx)?;
                }
                let plugin = self.records[idx].native.as_ref().expect("native 已启动");
                plugin.call(command, &args)
            }
        }
    }

    /// process 插件调用：崩溃/挂死自动重启（限次）。
    fn invoke_process(&mut self, idx: usize, command: &str, args: Value) -> Result<Value, String> {
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
        match self.records[idx].manifest.runtime {
            PluginRuntime::Webview => Ok(()),
            PluginRuntime::Process => self.start_process(idx),
            PluginRuntime::Native => self.start_native(idx),
        }
    }

    /// 启动 process 插件：spawn 子进程 + init 握手（声明命令）。
    fn start_process(&mut self, idx: usize) -> Result<(), String> {
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
        // 事件桥：从进程级总线取发送端（setup 已初始化；兜底丢弃通道）
        let event_tx = events::sender().unwrap_or_else(|| {
            let (tx, _rx) = std::sync::mpsc::channel();
            tx
        });
        let mut plugin =
            ProcessPlugin::spawn(&id, &cmd[0], &cmd[1..], &dir, &vault, perms, event_tx)?;
        let commands = plugin.init(API_TIMEOUT)?;
        self.records[idx].commands = commands;
        self.records[idx].process = Some(plugin);
        self.records[idx].error = None;
        Ok(())
    }

    /// 启动 native 插件：加载 DLL + 创建实例（配置含 vault 路径与配置目录）。
    fn start_native(&mut self, idx: usize) -> Result<(), String> {
        let (id, cmd, dir, vault) = {
            let rec = &self.records[idx];
            (
                rec.manifest.id.clone(),
                rec.manifest.command.clone(),
                rec.dir.clone(),
                self.vault.clone(),
            )
        };
        let cmd = cmd.ok_or("native 插件缺少 command")?;
        if cmd.is_empty() {
            return Err("native 插件 command 为空".to_string());
        }
        // 安全（S1b）：native 运行时 = 把 DLL 加载进宿主进程（完全控制），
        // 只允许随应用分发的核心插件（目录在 plugins/_core 下）。第三方插件
        // 目录声明 runtime=native 一律拒绝——否则任意插件目录放一个 DLL
        // 即可在宿主进程内执行任意代码。manifest 里声明信任模型（"核心插件是
        // 信任代码"）必须与这里的加载路径强制一致。
        let is_core = dir
            .parent()
            .and_then(|p| p.file_name())
            .map(|n| n == CORE_DIR)
            .unwrap_or(false);
        if !is_core {
            return Err(format!(
                "插件 {id} 声明了 native 运行时，但不在核心插件目录（仅随应用分发的核心插件允许 native，已拒绝加载）"
            ));
        }
        let vault = vault.ok_or("vault 未设置")?;
        let config_dir = self.config_dir.clone().unwrap_or_default();
        let config = serde_json::json!({
            "vault": vault.to_string_lossy(),
            "config_dir": config_dir,
        })
        .to_string();
        let plugin = NativePlugin::load(&dir.join(&cmd[0]), &id, &config)?;
        self.records[idx].native = Some(plugin);
        // native 命令由插件内部分发，无握手声明
        self.records[idx].error = None;
        Ok(())
    }

    fn stop_record(&mut self, idx: usize) {
        if let Some(p) = self.records[idx].process.take() {
            p.shutdown();
        }
        // native：Drop 即销毁插件实例并释放 DLL（Windows 上文件随即可覆盖）
        self.records[idx].native.take();
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

fn ensure_refreshed(m: &mut PluginManager, app: &tauri::AppHandle, vault: &str) -> Result<(), String> {
    let v = PathBuf::from(vault);
    let changed_vault = match &m.vault {
        Some(cur) => !paths_equal(cur, &v),
        None => true,
    };
    // 插件目录增删但 vault 路径未变：靠全局目录快照检测（否则前端"刷新"发现不了新插件）
    let global = global_plugins_dir(app)?;
    let snapshot = plugins_snapshot(&global);
    let changed_plugins = m.last_snapshot.as_ref() != Some(&snapshot);
    if changed_vault || changed_plugins {
        m.refresh(app, &v)?;
        m.last_snapshot = Some(snapshot);
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
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
) -> Result<Vec<PluginInfo>, String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    Ok(m.list())
}

#[tauri::command]
pub async fn plugins_set_enabled(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    m.set_enabled(&app, &id, enabled)
}

/// 卸载插件：停进程 + 清启用状态 + 删除插件目录。
#[tauri::command]
pub async fn plugins_uninstall(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
) -> Result<(), String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    m.uninstall(&app, &id)
}

/// 重新安装已卸载的核心插件（从随应用分发的资源恢复）。
#[tauri::command]
pub async fn plugins_reinstall_core(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
) -> Result<(), String> {
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    if !is_safe_plugin_id(&id) {
        return Err(format!("非法插件 id: {id}"));
    }
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    m.reinstall_core(&app, &id)
}

/// 已卸载的核心插件 id 列表（前端"重新安装"入口用；全局状态，无需 vault）。
#[tauri::command]
pub async fn plugins_removed_core(app: tauri::AppHandle) -> Vec<String> {
    let removed = load_removed_core(&app);
    let mut v: Vec<String> = removed.into_iter().collect();
    v.sort();
    v
}

/// 界面安装 DLL 插件：source = 用户选择的 .zip 包路径或插件目录路径；kind = "zip" | "dir"。
/// 返回安装后的插件 id。
#[tauri::command]
pub async fn plugins_install_native(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    source: String,
    kind: String,
) -> Result<String, String> {
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    m.install_native(&app, &source, &kind)
}

/// 在解包目录中定位插件清单：根 plugin.json，或唯一子目录下的 plugin.json
/// （常见打包结构 `<id>/plugin.json` + DLL）。
fn find_plugin_manifest(root: &Path) -> Result<(PathBuf, PluginManifest), String> {
    let read_manifest = |dir: &Path| -> Result<PluginManifest, String> {
        let raw = std::fs::read_to_string(dir.join("plugin.json"))
            .map_err(|e| format!("读取 plugin.json 失败: {e}"))?;
        serde_json::from_str(&raw).map_err(|e| format!("plugin.json 解析失败: {e}"))
    };
    if root.join("plugin.json").is_file() {
        let m = read_manifest(root)?;
        return Ok((root.to_path_buf(), m));
    }
    let dirs: Vec<PathBuf> = std::fs::read_dir(root)
        .map_err(|e| format!("读取插件包失败: {e}"))?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.path())
        .collect();
    if dirs.len() == 1 && dirs[0].join("plugin.json").is_file() {
        let m = read_manifest(&dirs[0])?;
        return Ok((dirs[0].clone(), m));
    }
    Err("未找到 plugin.json（插件包应包含清单文件）".into())
}

#[tauri::command]
pub async fn plugins_reload(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
) -> Result<(), String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    m.reload(&id)
}

/// 插件 id 安全校验：小写字母/数字开头，仅含小写字母/数字/`-`/`_`。
/// 用于所有"id 拼进文件路径"的入口——拒绝 `..`、`/`、`\`、绝对路径等，
/// 防路径穿越（如 `id="../../.."` 把目录根引到任意位置后读取任意文件）。
pub fn is_safe_plugin_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// 读取插件目录内的文件（前端加载 webview 插件入口 / 核心插件自带 ui 用）。
/// 限定在插件目录内：id 白名单 + 拒绝绝对路径与 `..` 段 + root 规范化复核。
/// 核心插件在 `_core/<id>` 子目录。
#[tauri::command]
pub async fn plugins_read_file(
    app: tauri::AppHandle,
    id: String,
    rel: String,
) -> Result<String, String> {
    // 安全（S1a）：id 必须为合法插件名。历史漏洞——id 未校验就拼路径，
    // `id="../../.."` 会让候选 root 指向插件根之外任意**已存在**目录，
    // 此时 rel 只要不含非法组件即可读取该目录下任意文本文件。
    if !is_safe_plugin_id(&id) {
        return Err(format!("非法插件 id: {id}"));
    }
    let base = global_plugins_dir(&app)?;
    let candidates = [base.join(CORE_DIR).join(&id), base.join(&id)];
    let root = candidates
        .iter()
        .find(|p| p.is_dir())
        .ok_or("插件不存在")?
        .clone();
    // 纵深防御：root 规范化后必须仍在插件根内（防符号链接 / `..` 残留把
    // 目录引出去）。canonicalize 失败（目录异常）则拒绝读取。
    let base_canon = base.canonicalize().map_err(|e| format!("插件根异常: {e}"))?;
    let root_canon = root.canonicalize().map_err(|e| format!("插件目录异常: {e}"))?;
    if !root_canon.starts_with(&base_canon) {
        return Err(format!("非法插件目录: {id}"));
    }
    let rel_path = Path::new(&rel);
    let bad = rel_path.is_absolute()
        || rel_path.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        });
    if bad {
        return Err(format!("非法路径: {rel}"));
    }
    let p = root.join(rel_path);
    if !p.starts_with(&root) {
        return Err(format!("路径越界: {rel}"));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("读取插件文件失败: {e}"))
}

#[tauri::command]
pub async fn plugins_invoke(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    m.invoke(&id, &command, args)
}

/// 统一插件命令调用（任何 runtime）：native → FFI；process → JSON-RPC；
/// webview → 拒绝（由前端注册表调用）。核心插件（如 records）走这里。
#[tauri::command]
pub async fn plugin_call(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    m.invoke(&id, &command, args)
}

/// 聚合搜索：宿主内嵌全文搜索（FTS，core::search）+ 所有启用的搜索提供者
/// 插件的 `search.provide` 命中（来源以 source 字段标记）。
#[tauri::command]
pub async fn search_all(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    query: String,
) -> Result<serde_json::Value, String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    // 锁内只做"刷新 + 收集提供者列表"（快）；FTS 与提供者聚合都在锁外执行
    let providers: Vec<String> = {
        let mut m = state.lock().map_err(|e| e.to_string())?;
        ensure_refreshed(&mut m, &app, &vault)?;
        m.records
            .iter()
            .filter(|r| r.manifest.search_provider && m.plugin_enabled(&r.manifest.id))
            .map(|r| r.manifest.id.clone())
            .collect()
    };

    // 1. 全文搜索（宿主内嵌 core::search，SQLite FTS5）与提供者聚合**并行**：
    // FTS 不碰插件状态（可能涉及索引同步，耗时），放独立线程执行，
    // 不占插件全局锁、不与提供者调用互相等待。提供者调用仍需 &mut
    // PluginManager（进程句柄/序号），在锁内串行，每个提供者独立 30s 超时。
    let fts_vault = vault.clone();
    let fts_query = query.clone();
    let fts_handle = std::thread::spawn(move || crate::core::search::search(&fts_vault, &fts_query));

    // 2. 插件提供者命中（启用且声明 searchProvider）
    let mut provider_hits: Vec<Value> = Vec::new();
    {
        let mut m = state.lock().map_err(|e| e.to_string())?;
        for pid in providers {
            let params = serde_json::json!({ "query": query, "limit": 20 });
            if let Ok(mut ph) = m.invoke(&pid, "search.provide", params) {
                if let Some(arr) = ph.as_array_mut() {
                    for h in arr {
                        // 统一结构：provider 的 title 作为 filename；source 标记来源
                        if h.get("filename").is_none() {
                            if let Some(t) = h.get("title").and_then(|v| v.as_str()) {
                                h["filename"] = Value::String(t.to_string());
                            }
                        }
                        h["source"] = Value::String(pid.clone());
                        provider_hits.push(h.clone());
                    }
                }
            }
        }
    }

    // 3. 汇总：FTS 命中在前（主搜索结果），提供者命中在后（带 source 徽章）
    let mut hits: Vec<Value> = Vec::new();
    match fts_handle.join() {
        Ok(Ok(fts_hits)) => {
            for h in fts_hits {
                if let Ok(v) = serde_json::to_value(h) {
                    hits.push(v);
                }
            }
        }
        Ok(Err(e)) => eprintln!("[search] 全文搜索失败: {e}"),
        Err(_) => eprintln!("[search] 全文搜索线程异常"),
    }
    hits.extend(provider_hits);
    Ok(Value::Array(hits))
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::Message;
    use serde_json::json;
    use std::sync::mpsc::channel;

    /// 插件 id 白名单（S1a 第一道闸）：合法 id 通过，穿越/绝对路径/非法字符拒绝。
    #[test]
    fn safe_plugin_id_validation() {
        for ok in ["core-notes", "a", "a1", "my_plugin", "x-y_z2"] {
            assert!(is_safe_plugin_id(ok), "{ok} 应合法");
        }
        for bad in [
            "", ".", "..", "../evil", "..\\evil", "/abs", "C:/evil", "a/b", "a b", "-lead",
            "UPPER", "中文", "a..b",
        ] {
            assert!(!is_safe_plugin_id(bad), "{bad:?} 应非法");
        }
    }

    /// native 运行时只允许 _core 目录（S1b）：外部目录的 native 插件拒绝启动。
    #[test]
    fn start_native_rejects_non_core_dir() {
        let mut m = PluginManager::default();
        m.vault = Some(PathBuf::from("C:/vault"));
        m.records.push(PluginRecord {
            manifest: PluginManifest {
                id: "evil".into(),
                name: "evil".into(),
                version: "0.1.0".into(),
                runtime: PluginRuntime::Native,
                entry: None,
                command: Some(vec!["evil.dll".into()]),
                permissions: Vec::new(),
                description: String::new(),
                config: serde_json::Value::Null,
                search_provider: false,
                system: false,
                ui: None,
                nav: Vec::new(),
            },
            // 目录在插件根之外（父目录不是 _core）
            dir: PathBuf::from("C:/outside/plugins/evil"),
            commands: Vec::new(),
            error: None,
            process: None,
            native: None,
            restarts: 0,
            last_crash: None,
        });
        let err = m.start_native(0).unwrap_err();
        assert!(err.contains("不在核心插件目录"), "应拒绝外部 native 插件: {err}");
    }

    /// native 运行时 _core 目录放行（S1b 正向）：核心插件仍能正常加载。
    /// 需要已构建 tb_notes.dll（cargo build -p tb-notes），否则跳过。
    #[test]
    fn start_native_accepts_core_dir() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tb_notes.dll");
        if !dll.exists() {
            eprintln!("[skip] 请先构建核心插件: cargo build -p tb-notes");
            return;
        }
        let base = std::env::temp_dir().join(format!("tb-native-core-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // 模拟 plugins/_core/core-notes/（含 DLL）
        let core_dir = base.join("plugins/_core/core-notes");
        std::fs::create_dir_all(&core_dir).unwrap();
        std::fs::copy(&dll, core_dir.join("tb_notes.dll")).unwrap();

        let mut m = PluginManager::default();
        m.vault = Some(PathBuf::from("C:/vault"));
        m.config_dir = Some(base.to_string_lossy().to_string());
        m.records.push(PluginRecord {
            manifest: PluginManifest {
                id: "core-notes".into(),
                name: "笔记".into(),
                version: "0.1.0".into(),
                runtime: PluginRuntime::Native,
                entry: None,
                command: Some(vec!["tb_notes.dll".into()]),
                permissions: Vec::new(),
                description: String::new(),
                config: serde_json::Value::Null,
                search_provider: false,
                system: false,
                ui: None,
                nav: Vec::new(),
            },
            dir: core_dir,
            commands: Vec::new(),
            error: None,
            process: None,
            native: None,
            restarts: 0,
            last_crash: None,
        });
        m.start_native(0).expect("_core 下的 native 插件应能启动");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A6 回归：核心插件**首次扫描**（records 为空）时 native 判定不依赖 records，
    /// 应立即启动（native 实例非 None）。历史 bug：plugin_enabled 靠 records 判断
    /// native，而 scan 在 push 之前调用它，导致首次刷新核心插件全部 stopped。
    #[test]
    fn scan_starts_native_on_first_pass() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tb_notes.dll");
        if !dll.exists() {
            eprintln!("[skip] 请先构建核心插件: cargo build -p tb-notes");
            return;
        }
        let base = std::env::temp_dir().join(format!("tb-scan-native-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let core_dir = base.join("plugins/_core/core-notes");
        std::fs::create_dir_all(&core_dir).unwrap();
        std::fs::copy(&dll, core_dir.join("tb_notes.dll")).unwrap();
        std::fs::write(
            core_dir.join("plugin.json"),
            serde_json::json!({
                "id": "core-notes",
                "name": "笔记",
                "version": "0.1.0",
                "runtime": "native",
                "command": ["tb_notes.dll"]
            })
            .to_string(),
        )
        .unwrap();

        let mut m = PluginManager::default();
        m.vault = Some(PathBuf::from("C:/vault"));
        m.config_dir = Some(base.to_string_lossy().to_string());
        m.scan_plugin_dir(&core_dir); // records 为空时的首次扫描
        assert_eq!(m.records.len(), 1);
        assert!(m.records[0].native.is_some(), "首次扫描即应启动 native 插件");
        assert!(m.records[0].error.is_none(), "不应有启动错误");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 打包资源部署：src（模拟 resource_dir/_core）→ dst，清空后整体复制。
    #[test]
    fn deploy_core_plugins_copies_tree() {
        let base = std::env::temp_dir().join(format!("tb-deploy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src/_core");
        std::fs::create_dir_all(src.join("core-notes")).unwrap();
        std::fs::write(src.join("core-notes/plugin.json"), "{}").unwrap();
        std::fs::write(src.join("core-notes/tb_notes.dll"), "dll-bytes").unwrap();
        std::fs::create_dir_all(src.join("core-blog")).unwrap();
        std::fs::write(src.join("core-blog/plugin.json"), "{}").unwrap();

        let dst = base.join("dst/_core");
        // 已卸载的插件（removed_core）跳过部署
        let removed = HashSet::from(["core-blog".to_string()]);
        deploy_core_plugins(&src, &dst, &removed).unwrap();
        assert!(dst.join("core-notes/plugin.json").is_file());
        assert!(dst.join("core-notes/tb_notes.dll").is_file());
        assert!(!dst.join("core-blog/plugin.json").exists(), "已卸载插件应跳过部署");

        // 重复部署 + 手动安装的本地插件保留：
        // 用户把 DLL 插件目录放入 _core 后，随包部署不清空它（重启后仍可用）
        std::fs::write(dst.join("core-notes/plugin.json"), "{}").unwrap();
        std::fs::create_dir_all(dst.join("core-mine")).unwrap();
        std::fs::write(dst.join("core-mine/plugin.json"), "{}").unwrap();
        std::fs::write(dst.join("core-mine/tb_mine.dll"), "dll").unwrap();
        std::fs::write(dst.join("stale.txt"), "old").unwrap();
        deploy_core_plugins(&src, &dst, &HashSet::new()).unwrap();
        assert!(
            dst.join("core-mine/plugin.json").is_file(),
            "用户手动安装的插件应保留（不清空 _core）"
        );
        assert!(dst.join("core-mine/tb_mine.dll").is_file());
        assert!(dst.join("core-blog/plugin.json").is_file(), "清除标记后恢复部署");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 原生核心插件全链路：真实 DLL 加载 → create → notes CRUD。
    /// 需要先构建核心插件（`cargo build -p tb-notes`），DLL 不存在时跳过。
    #[test]
    fn native_plugin_load_and_call() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tb_notes.dll");
        if !dll.exists() {
            eprintln!("[skip] 请先构建核心插件: cargo build -p tb-notes");
            return;
        }
        let base = std::env::temp_dir().join(format!("tb-native-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let vault = base.join("vault");
        std::fs::create_dir_all(vault.join("notes")).unwrap();

        let cfg = json!({ "vault": vault.to_string_lossy() }).to_string();
        let plugin = NativePlugin::load(&dll, "core-notes", &cfg).expect("DLL 应能加载");

        // 新建
        plugin.call("notes.create", &json!({ "rel": "notes/测试.md" })).unwrap();
        assert!(vault.join("notes/测试.md").exists(), "文件应创建");

        // 写入 + 读取
        plugin.call("notes.write", &json!({ "rel": "notes/测试.md", "content": "# 你好\n" })).unwrap();
        let content = plugin.call("notes.read", &json!({ "rel": "notes/测试.md" })).unwrap();
        assert_eq!(content, "# 你好\n");

        // 重命名
        plugin.call("notes.rename", &json!({ "from": "notes/测试.md", "to": "notes/改名.md" })).unwrap();
        assert!(!vault.join("notes/测试.md").exists());
        assert!(vault.join("notes/改名.md").exists());

        // 列表
        let list = plugin.call("notes.list", &json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1, "应只剩改名后的笔记");

        // 删除
        plugin.call("notes.delete", &json!({ "rel": "notes/改名.md" })).unwrap();
        assert!(plugin.call("notes.list", &json!({})).unwrap().as_array().unwrap().is_empty());

        // 未知命令 → 错误
        let err = plugin.call("no.such", &json!({})).unwrap_err();
        assert!(err.contains("未知命令"), "错误信息: {err}");

        drop(plugin);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 旧布局迁移：vault/plugins/* → 全局目录（复制 + 整体回收站清理）。
    #[test]
    fn migrate_vault_plugins_copies_and_cleans() {
        let base = std::env::temp_dir().join(format!("tb-plugin-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let vault = base.join("vault");
        let global = base.join("global-plugins");
        std::fs::create_dir_all(vault.join("plugins/a-plugin")).unwrap();
        std::fs::write(
            vault.join("plugins/a-plugin/plugin.json"),
            r#"{"id":"a-plugin","name":"A","version":"0.1.0","runtime":"process","command":["python","main.py"]}"#,
        )
        .unwrap();
        std::fs::write(vault.join("plugins/a-plugin/main.py"), "print('hi')").unwrap();
        // 无清单的目录不迁移
        std::fs::create_dir_all(vault.join("plugins/not-a-plugin")).unwrap();
        std::fs::write(vault.join("plugins/not-a-plugin/readme.txt"), "x").unwrap();

        let n = migrate_vault_plugins(&vault, &global).unwrap();
        assert_eq!(n, 1, "只迁移含清单的插件");
        assert!(global.join("a-plugin/plugin.json").is_file(), "插件应复制到全局");
        assert!(!vault.join("plugins").exists(), "vault/plugins 应整体进回收站");

        // 幂等：vault/plugins 已不存在 → 无事可做
        assert_eq!(migrate_vault_plugins(&vault, &global).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 全局已有同 id 时保留全局版本（vault 版本丢弃）。
    #[test]
    fn migrate_skips_existing_global_id() {
        let base = std::env::temp_dir().join(format!("tb-plugin-migrate2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let vault = base.join("vault");
        let global = base.join("global-plugins");
        std::fs::create_dir_all(vault.join("plugins/dup")).unwrap();
        std::fs::write(
            vault.join("plugins/dup/plugin.json"),
            r#"{"id":"dup","name":"旧","version":"0.0.1","runtime":"webview","entry":"main.js"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(global.join("dup")).unwrap();
        std::fs::write(global.join("dup/plugin.json"), "全局版本").unwrap();

        let n = migrate_vault_plugins(&vault, &global).unwrap();
        assert_eq!(n, 1);
        let g = std::fs::read_to_string(global.join("dup/plugin.json")).unwrap();
        assert_eq!(g, "全局版本", "不应覆盖已有全局插件");
        let _ = std::fs::remove_dir_all(&base);
    }

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
        let mut p = ProcessPlugin::spawn(
            &m.id,
            &cmd[0],
            &cmd[1..],
            &plugin_dir,
            &vault,
            perms,
            channel().0,
        )
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

    /// 事件桥：csv-tool 的 csv.eventTest 发 Notification → 事件总线收到
    /// （ProcessPlugin 只持 mpsc Sender，不接触 tauri 类型——规避历史加载崩溃）。
    #[test]
    fn bridge_event_forward() {
        use crate::plugins::events::PluginEvent;
        use std::sync::mpsc::channel;
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let plugin_dir = base.join("plugins").join("csv-tool");
        let manifest_raw =
            std::fs::read_to_string(plugin_dir.join("plugin.json")).expect("示例插件应存在");
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        let cmd = m.command.clone().unwrap();
        let vault = std::env::temp_dir();
        let (event_tx, event_rx) = channel::<PluginEvent>();
        let mut p = ProcessPlugin::spawn(
            &m.id,
            &cmd[0],
            &cmd[1..],
            &plugin_dir,
            &vault,
            m.permissions.clone(),
            event_tx,
        )
        .expect("应能启动 python 进程");
        p.init(Duration::from_secs(15)).unwrap();
        let res = p
            .call(
                "csv.eventTest",
                json!({ "percent": 60 }),
                Duration::from_secs(15),
            )
            .unwrap();
        assert!(
            res["text"].as_str().unwrap().contains("3 个进度事件"),
            "结果: {res}"
        );
        // 应收到 3 个 progress 事件（调用期间实时转发）
        let ev = event_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(ev.plugin_id, "csv-tool");
        assert_eq!(ev.event, "progress");
        assert_eq!(ev.data["percent"], 20);
        assert_eq!(
            event_rx.try_iter().count(),
            2,
            "还应有剩余 2 个事件"
        );
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
        let mut p = ProcessPlugin::spawn(
            &m.id,
            &cmd[0],
            &cmd[1..],
            &plugin_dir,
            &vault,
            perms,
            channel().0,
        )
        .unwrap();
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
            channel().0,
        )
        .expect("应能启动 python");
        let err = p.init(Duration::from_millis(800)).unwrap_err();
        assert!(err.contains("超时") || err.contains("timeout"), "错误信息: {err}");
        p.shutdown();
    }

    /// stdin 写入超时：插件不读 stdin（挂死），管道缓冲写满后
    /// 写入不得无限阻塞——应超时返回错误并终止进程。
    #[test]
    fn stdin_write_timeout_kills_hung_plugin() {
        let vault = std::env::temp_dir();
        let mut p = ProcessPlugin::spawn(
            "hung",
            "python",
            &[
                "-u".to_string(),
                "-c".to_string(),
                "import time; time.sleep(60)".to_string(),
            ],
            &vault,
            &vault,
            vec![],
            channel().0,
        )
        .expect("应能启动 python");
        // 大载荷（远超管道缓冲）写入无人消费的 stdin → 写线程阻塞
        let big = json!({ "payload": "x".repeat(256 * 1024) });
        let t0 = Instant::now();
        let err = p
            .send_timeout(
                &Message::request(1, "call", big),
                Duration::from_millis(800),
            )
            .unwrap_err();
        let elapsed = t0.elapsed();
        assert!(
            err.contains("超时") || err.contains("stdin") || err.contains("挂死"),
            "错误信息: {err}"
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "写入不应无限阻塞，实际 {elapsed:?}"
        );
        // kill 是异步的：轮询等待进程被系统回收
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut exited = false;
        while Instant::now() < deadline {
            if p.has_exited() {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(exited, "挂死插件应被终止");
        p.shutdown();
    }
}
