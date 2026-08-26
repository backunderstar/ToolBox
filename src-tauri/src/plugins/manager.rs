//! 插件管理器核心：清单发现、注册表、生命周期（启用/禁用/热重载/崩溃重启）、
//! 卸载/安装（含 zip-slip 防护）、随包核心插件部署与旧布局迁移。
//!
//! 结构（2026-08 拆分，原 mod.rs 1935 行）：命令层在兄弟模块 `commands`，
//! 类型/运行时在 `manifest` / `native` / `process` / `events`。
//! 被命令层与测试跨模块访问的私有项标 `pub(crate)`。

use super::events;
use super::manifest::{is_valid_plugin_id, NavDecl, PluginManifest, PluginRuntime, ThemeDecl};
use super::native::NativePlugin;
use super::process::ProcessPlugin;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::Manager;

pub const API_TIMEOUT: Duration = Duration::from_secs(30);
/// 崩溃自动重启上限（窗口期内）。
const MAX_RESTARTS: u32 = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);

/// 递归复制最大深度：恶意/意外的万层嵌套会让纯递归栈溢出直接 abort（Rust
/// 栈溢出不可捕获）；超过上限中止复制（与 backup/search 的 MAX_DEPTH 语义一致）。
const COPY_MAX_DEPTH: usize = 64;

/// zip 插件包解压防护（zip 炸弹）：条目数与累计解压大小上限。
/// 正常插件包（DLL + UI + 清单）远小于这些值；恶意包可用超高压缩比把
/// 几 MB 的 zip 膨胀成数百 GB 占满磁盘——解压前按**未压缩大小**预检并中止。
const ZIP_MAX_ENTRIES: usize = 1024;
const ZIP_MAX_BYTES: u64 = 512 * 1024 * 1024;

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
    /// 主题声明（皮肤插件）：非空时本插件是主题包，启用后并入主题选择器
    pub theme: Option<ThemeDecl>,
}

#[derive(Default)]
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
    /// AppHandle（refresh/启停流程记录）：process 插件解释器解析（捆绑 Python 运行时）
    /// 需要定位 %APPDATA% 与资源目录；测试等未设置时回落系统 PATH。
    pub(crate) app: Option<tauri::AppHandle>,
}


/// plugins/ 目录内容快照：有 plugin.json 的目录名（排序）+ `_core` 容器下的
/// 子目录名（核心/手动安装插件）。任何增删/清单变化都会改变快照，从而触发
/// 重新发现——包括用户手动放入 _core 的 DLL 插件目录（_core 本身无 plugin.json，
/// 不含它的话新增子目录不会改变快照，导致"放进去刷新不识别"）。
pub(crate) fn plugins_snapshot(dir: &Path) -> Vec<String> {
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

/* ---------------- 全局插件目录与启用状态（默认 %APPDATA%，可自定义） ----------------
   插件是"工具/程序"，不属于某个工作区数据：统一装在全局插件目录，换工作区无需
   重装。默认 %APPDATA%/com.toolbox.desktop/plugins/；用户可在插件页自定义
   （plugins.json 顶层 "plugins_dir" 键），缺省回退默认目录。
   启用状态同样全局（plugins.json 顶层 {enabled:[...]}）。
   兼容迁移：
   - 旧状态格式（按 vault 分键的 map）首次读取时并集迁移
   - 旧 vault/.toolbox/plugins.json 迁移进全局后删除
   - 旧 vault/plugins 目录中的插件自动复制到全局后整体进回收站 */

/// 默认全局插件根目录（%APPDATA%/com.toolbox.desktop/plugins/）。
pub(crate) fn default_plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    Ok(dir.join("plugins"))
}

/// 当前生效的全局插件根目录：优先用户自定义（plugins.json 的 "plugins_dir" 键），
/// 缺省用默认目录。所有"插件装哪/从哪发现"都经这里（manager/commands 统一入口）。
pub(crate) fn global_plugins_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let p = match load_state_map(app)
        .get("plugins_dir")
        .and_then(|v| v.as_str())
    {
        Some(custom) if !custom.trim().is_empty() => PathBuf::from(custom.trim()),
        _ => default_plugins_dir(app)?,
    };
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
    // 部署到当前生效的全局插件目录（跟随用户自定义）
    let Ok(dst) = global_plugins_dir(app).map(|p| p.join(CORE_DIR)) else {
        return;
    };
    let removed = load_removed_core(app);
    match deploy_core_plugins(&src, &dst, &removed) {
        Ok(()) => crate::core::log::info(&format!(
            "[plugin] 已部署随应用分发的核心插件到 {:?}",
            dst
        )),
        Err(e) => crate::core::log::error(&format!("[plugin] 核心插件资源部署失败: {e}")),
    }
}

/// 部署实现（可测）：**随包插件逐个覆盖部署**，不清空整个目标——
/// `_core` 下用户手动安装的本地 DLL 插件（非随包）保留，刷新后自动识别为原生插件。
/// 已卸载的核心插件（removed_core）跳过部署。
/// 仅打包构建（`#[cfg(not(dev))]` 的 ensure_core_plugins）与测试使用；dev 下无
/// 调用方，压制 dead_code 避免告警（release 仍在用）。
#[cfg_attr(dev, allow(dead_code))]
pub(crate) fn deploy_core_plugins(src: &Path, dst: &Path, removed: &HashSet<String>) -> Result<(), String> {
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
pub(crate) fn load_removed_core(app: &tauri::AppHandle) -> HashSet<String> {
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

pub(crate) fn save_removed_core(app: &tauri::AppHandle, removed: &HashSet<String>) -> Result<(), String> {
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
pub(crate) fn core_plugin_source(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
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

pub(crate) fn load_state_map(app: &tauri::AppHandle) -> serde_json::Map<String, Value> {
    let Ok(p) = state_path(app) else {
        return serde_json::Map::new();
    };
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub(crate) fn save_state_map(app: &tauri::AppHandle, map: &serde_json::Map<String, Value>) -> Result<(), String> {
    let p = state_path(app)?;
    let raw = serde_json::to_string_pretty(&Value::Object(map.clone())).map_err(|e| e.to_string())?;
    // 原子写：临时文件 + rename。避免写入中途崩溃/断电留下损坏 JSON，
    // 否则 load_state_map 会静默返回空 map，全部插件启用状态丢失。
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, &raw).map_err(|e| format!("保存启用状态失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("保存启用状态失败: {e}"))
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
    // 必须基于现有 map 增量更新，不能重新构造全新 map：plugins.json 还承载
    // 其他键（plugins_dir 自定义插件目录 / removed_core 已卸载核心插件标记），
    // 整体覆盖写回会把这些键抹掉 → 自定义目录静默回退默认、已卸载核心插件复活。
    let mut map = load_state_map(app);
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

/// 递归复制目录（深度护栏见 copy_dir_recursive_depth）。
pub(crate) fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    copy_dir_recursive_depth(src, dst, 0)
}

fn copy_dir_recursive_depth(src: &Path, dst: &Path, depth: usize) -> Result<(), String> {
    if depth > COPY_MAX_DEPTH {
        return Err(format!(
            "目录嵌套过深（>{COPY_MAX_DEPTH} 层），已中止复制: {}",
            src.display()
        ));
    }
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败 {dst:?}: {e}"))?;
    let read = std::fs::read_dir(src).map_err(|e| format!("读取目录失败 {src:?}: {e}"))?;
    for entry in read.flatten() {
        let s = entry.path();
        let d = dst.join(entry.file_name());
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            copy_dir_recursive_depth(&s, &d, depth + 1)?;
        } else {
            std::fs::copy(&s, &d).map_err(|e| format!("复制失败 {s:?}: {e}"))?;
        }
    }
    Ok(())
}

/// 迁移旧 vault/plugins/* → 全局目录；完成后 vault/plugins 整体进回收站。
/// 幂等：vault/plugins 不存在或已空时无事可做。返回迁移的插件数。
pub(crate) fn migrate_vault_plugins(vault: &Path, global: &Path) -> Result<usize, String> {
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
    // 有插件才整体进回收站，vault 保持纯净（空目录不回收，避免误删用户手动创建的目录）
    if has_plugin {
        if let Err(e) = trash::delete(&src) {
            crate::core::log::error(&format!(
                "[plugins] vault 旧插件目录移入回收站失败（{src:?}）: {e}"
            ));
        }
    }
    Ok(migrated)
}

/* ---------------- 管理器 ---------------- */

/// 路径比较：Windows 下大小写不敏感（避免用户传 C:/A 与 c:/a 导致反复刷新重启插件）。
#[cfg(target_os = "windows")]
fn paths_equal(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

#[cfg(not(target_os = "windows"))]
fn paths_equal(a: &Path, b: &Path) -> bool {
    a == b
}

impl PluginManager {
    /// 列表前的"确保已刷新"：vault 或全局插件目录快照变化时重新发现/启动插件。
    /// 命令层各命令与 lib.rs 启动预热共用——预热提前执行首次 refresh，避免用户
    /// 首次打开应用/插件页时阻塞；快照未变则直接跳过（幂等）。
    pub(crate) fn ensure_refreshed(
        &mut self,
        app: &tauri::AppHandle,
        vault: &str,
    ) -> Result<(), String> {
        let v = PathBuf::from(vault);
        let changed_vault = match &self.vault {
            Some(cur) => !paths_equal(cur, &v),
            None => true,
        };
        let global = global_plugins_dir(app)?;
        let snapshot = plugins_snapshot(&global);
        let changed_plugins = self.last_snapshot.as_ref() != Some(&snapshot);
        if changed_vault || changed_plugins {
            self.refresh(app, &v)?;
            self.last_snapshot = Some(snapshot);
        }
        Ok(())
    }

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
        self.app = Some(app.clone());
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
            crate::core::log::error(&format!("[plugin] vault 插件迁移失败: {e}"));
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
    pub(crate) fn plugin_enabled(&self, id: &str) -> bool {
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
    pub(crate) fn scan_plugin_dir(&mut self, dir: &Path) {
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
                        theme: None,
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
                theme: r.manifest.theme.clone(),
            })
            .collect()
    }

    pub fn set_enabled(&mut self, app: &tauri::AppHandle, id: &str, enabled: bool) -> Result<(), String> {
        self.app = Some(app.clone());
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

    /// 界面安装插件（用户选择的 .zip 包或插件目录）：通用 runtime。
    /// 解包/复制到临时目录 → 定位 plugin.json 校验（id 合法 + 清单完整）→
    /// 按 runtime 部署：
    /// - native（DLL）→ `_core/<id>`（DLL 加载进宿主进程 = 完全控制，仅允许
    ///   核心容器，安全模型同 §start_native 的 S1b）
    /// - webview / process / 主题皮肤 → `plugins/<id>`（外部插件目录，与手动
    ///   复制同安全边界：process 权限门控、webview 受限 API、主题纯数据）
    ///   → 扫描并启用启动。zip 解压带 zip-slip 防护。
    pub fn install(
        &mut self,
        app: &tauri::AppHandle,
        source: &str,
        kind: &str,
    ) -> Result<String, String> {
        self.app = Some(app.clone());
        if kind != "zip" && kind != "dir" {
            return Err(format!("未知安装来源: {kind}"));
        }
        let plugins_root = global_plugins_dir(app)?;
        let tmp = plugins_root.join(format!(".install-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败: {e}"))?;

        // 1. 解包到临时目录
        let unpack = || -> Result<(), String> {
            if kind == "zip" {
                let file =
                    std::fs::File::open(source).map_err(|e| format!("打开插件包失败: {e}"))?;
                let mut zip =
                    zip::ZipArchive::new(file).map_err(|e| format!("解析插件包失败: {e}"))?;
                // zip 炸弹防护：先按条目数与未压缩总大小预检（恶意包可把几 MB
                // 压缩包膨胀成数百 GB 占满磁盘；正常插件包远小于上限）
                if zip.len() > ZIP_MAX_ENTRIES {
                    return Err(format!(
                        "插件包条目过多（{} > {ZIP_MAX_ENTRIES}），已拒绝",
                        zip.len()
                    ));
                }
                let mut total_bytes = 0u64;
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
                        std::fs::create_dir_all(&out)
                            .map_err(|e| format!("创建目录失败: {e}"))?;
                    } else {
                        if let Some(p) = out.parent() {
                            std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败: {e}"))?;
                        }
                        let size = entry.size();
                        if total_bytes.saturating_add(size) > ZIP_MAX_BYTES {
                            return Err(format!(
                                "插件包解压总量超限（>{ZIP_MAX_BYTES} 字节），已拒绝"
                            ));
                        }
                        total_bytes += size;
                        let mut f =
                            std::fs::File::create(&out).map_err(|e| format!("写入失败: {e}"))?;
                        std::io::copy(&mut entry, &mut f)
                            .map_err(|e| format!("解压失败: {e}"))?;
                    }
                }
                Ok(())
            } else {
                copy_dir_recursive(Path::new(source), &tmp)
            }
        };
        unpack().inspect_err(|_e| {
            let _ = std::fs::remove_dir_all(&tmp);
        })?;

        // 2. 定位 plugin.json（根或唯一子目录——常见打包结构 <id>/plugin.json）
        let (manifest_dir, manifest) = find_plugin_manifest(&tmp).inspect_err(|_e| {
            let _ = std::fs::remove_dir_all(&tmp);
        })?;
        let bad = |e: String| {
            let _ = std::fs::remove_dir_all(&tmp);
            e
        };
        if !is_safe_plugin_id(&manifest.id) {
            return Err(bad(format!("非法插件 id: {}", manifest.id)));
        }
        // 按 runtime 校验清单完整性（与 manifest::validate 同规则，这里覆盖
        // UI 安装路径——用户可能绕过插件页直接给目录）
        match manifest.runtime {
            PluginRuntime::Native | PluginRuntime::Process => {
                if manifest
                    .command
                    .as_ref()
                    .map(|c| c.is_empty())
                    .unwrap_or(true)
                {
                    return Err(bad(format!(
                        "插件清单缺少 command（{} 运行时需要启动命令）: {}",
                        match manifest.runtime {
                            PluginRuntime::Native => "native（DLL 文件名）",
                            _ => "process（启动命令 argv）",
                        },
                        manifest.id
                    )));
                }
            }
            PluginRuntime::Webview => {
                // 纯主题插件（声明 theme）可无 entry
                if manifest.entry.as_deref().unwrap_or("").trim().is_empty()
                    && manifest.theme.is_none()
                {
                    return Err(bad(format!(
                        "webview 插件清单缺少 entry（JS 入口）: {}",
                        manifest.id
                    )));
                }
            }
        }
        let id = manifest.id.clone();
        let is_native = manifest.runtime == PluginRuntime::Native;
        let dst = if is_native {
            // native 只进 _core 容器（S1b：DLL 进宿主进程 = 完全控制）
            let core_root = plugins_root.join(CORE_DIR);
            std::fs::create_dir_all(&core_root)
                .map_err(|e| format!("创建核心插件目录失败: {e}"))?;
            core_root.join(&id)
        } else {
            plugins_root.join(&id)
        };
        if dst.exists() {
            return Err(bad(format!("插件已存在: {id}（如需重装请先卸载）")));
        }
        copy_dir_recursive(&manifest_dir, &dst).inspect_err(|_e| {
            let _ = std::fs::remove_dir_all(&tmp);
        })?;
        let _ = std::fs::remove_dir_all(&tmp);

        // 3. 扫描 + 默认启用 + 启动
        self.scan_plugin_dir(&dst);
        self.enabled.insert(id.clone());
        self.disabled.remove(&id);
        save_state(app, &self.enabled, &self.disabled)?;
        if let Some(idx) = self.records.iter().position(|r| r.manifest.id == id) {
            if self.plugin_enabled(&id) {
                self.start_record(idx).inspect_err(|e| {
                    self.records[idx].error = Some(e.clone());
                })?;
            }
        }
        Ok(id)
    }

    /// 重新安装已卸载的核心插件：从随应用分发的资源恢复目录 + 清"已卸载"标记 + 启用并启动。
    pub fn reinstall_core(&mut self, app: &tauri::AppHandle, id: &str) -> Result<(), String> {
        self.app = Some(app.clone());
        if !is_safe_plugin_id(id) {
            return Err(format!("非法插件 id: {id}"));
        }
        let src = core_plugin_source(app, id)?;
        // 部署到当前生效的全局插件目录（跟随用户自定义）
        let dst = global_plugins_dir(app)?.join(CORE_DIR).join(id);
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
                self.start_record(idx).inspect_err(|e| {
                    self.records[idx].error = Some(e.clone());
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
                .inspect_err(|e| {
                    self.records[idx].error = Some(e.clone());
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
            let (tx, _rx) = std::sync::mpsc::sync_channel(crate::plugins::events::EVENT_CAP);
            tx
        });
        // 解释器解析（三级）：插件目录自带 python.exe → 全局捆绑 → 系统 PATH。
        // 解析失败不阻断：保留原命令（系统 python），spawn 失败时给可读提示。
        let (program, resolved) = match super::pyruntime::resolve_interpreter(
            self.app.as_ref(),
            &dir,
            &cmd[0],
        ) {
            Ok(p) => (p.to_string_lossy().to_string(), true),
            Err(_) => (cmd[0].clone(), false),
        };
        let mut plugin = match ProcessPlugin::spawn(
            &id,
            &program,
            &cmd[1..],
            &dir,
            &vault,
            perms,
            event_tx,
        ) {
            Ok(p) => p,
            Err(e) => {
                // 解释器缺失是最常见的失败：给可读提示而不是裸的 spawn 错误
                let hint = if !resolved && super::pyruntime::is_python_command(&cmd[0]) {
                    format!(
                        "{e}\n提示：未找到 Python 解释器。目标机需安装 Python 并加入 PATH，\
                         或使用随应用分发的捆绑运行时（构建期 pnpm fetch:python）。"
                    )
                } else {
                    e
                };
                return Err(hint);
            }
        };
        // init 握手失败：附上插件 stderr 尾部（Python traceback 等），
        // 缺依赖（import 失败）时前端直接看到原因，而不是模糊的"进程已退出"。
        let commands = match plugin.init(API_TIMEOUT) {
            Ok(c) => c,
            Err(e) => {
                let tail = plugin.stderr_tail();
                let msg = if tail.is_empty() {
                    e
                } else {
                    format!("{e}\n插件 stderr（末尾）：\n{tail}")
                };
                return Err(msg);
            }
        };
        self.records[idx].commands = commands;
        self.records[idx].process = Some(plugin);
        self.records[idx].error = None;
        Ok(())
    }

    /// 启动 native 插件：加载 DLL + 创建实例（配置含 vault 路径与配置目录）。
    pub(crate) fn start_native(&mut self, idx: usize) -> Result<(), String> {
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

    /// 停掉全部 native 插件实例（释放 DLL 文件锁）。
    /// 插件目录迁移（plugins_dir_set）复制 `_core` 前必须调用——否则宿主
    /// 正加载的 DLL 在 Windows 上被独占锁住，复制报"另一个程序正在使用此文件"。
    /// 迁移后由调用方 refresh 重新发现并启动。
    pub(crate) fn stop_all_native(&mut self) {
        for rec in &mut self.records {
            if rec.manifest.runtime == PluginRuntime::Native {
                rec.native.take();
            }
        }
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

/// 插件 id 安全校验：与 `manifest::is_valid_plugin_id` 完全一致（单一规则源），
/// 安装路径（zip/目录）与清单加载共用，避免规则漂移。
pub fn is_safe_plugin_id(id: &str) -> bool {
    is_valid_plugin_id(id)
}

