//! 插件系统 IPC 命令层：全部 `#[tauri::command]`（调用 manager 核心）。
//! 每个命令先做 vault 作用域校验（S1c：vault 必须等于已配置工作区），
//! 再 `ensure_refreshed`（vault 或全局插件目录快照变化时重新发现），
//! 最后在锁内操作 PluginManager。

use crate::plugins::manager::{
    copy_dir_recursive, default_plugins_dir, global_plugins_dir, is_safe_plugin_id,
    load_removed_core, load_state_map, plugins_snapshot, save_state_map, PluginInfo,
    PluginManager, CORE_DIR,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

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

/// 界面安装插件（通用 runtime）：source = 用户选择的 .zip 包路径或插件目录路径；
/// kind = "zip" | "dir"。按清单 runtime 部署（native → _core/；其余 → plugins/），
/// 返回安装后的插件 id。
#[tauri::command]
pub async fn plugins_install(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    source: String,
    kind: String,
) -> Result<String, String> {
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, &app, &vault)?;
    m.install(&app, &source, &kind)
}

/// 读取当前生效的全局插件目录（自定义或默认 %APPDATA%）。
#[tauri::command]
pub fn plugins_dir_get(app: tauri::AppHandle) -> Result<String, String> {
    Ok(global_plugins_dir(&app)?.to_string_lossy().to_string())
}

/// 设置全局插件目录：迁移现有插件（复制到新目录，旧目录进回收站）后切换。
/// path 传空字符串/None 恢复默认（%APPDATA%/com.toolbox.desktop/plugins）。
/// 迁移前停掉全部 native 插件释放 DLL 文件锁（否则 Windows 上复制 _core 失败）。
/// 返回生效后的目录路径。
#[tauri::command]
pub async fn plugins_dir_set(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    path: Option<String>,
) -> Result<String, String> {
    let old = global_plugins_dir(&app)?;
    let trimmed = path.as_deref().unwrap_or("").trim();
    // 恢复默认：清配置键
    let mut map = load_state_map(&app);
    let new = if trimmed.is_empty() {
        map.remove("plugins_dir");
        default_plugins_dir(&app)?
    } else {
        let p = PathBuf::from(trimmed);
        // 防呆：新目录不能是旧目录内部（迁移时复制进自己子目录会混乱）
        if p.starts_with(&old) {
            return Err("新插件目录不能位于当前插件目录内部".to_string());
        }
        map.insert("plugins_dir".into(), Value::String(trimmed.to_string()));
        p
    };
    if new == old {
        return Ok(new.to_string_lossy().to_string());
    }
    // 迁移前：停掉全部 native 插件（释放 DLL 文件锁），迁移后 refresh 重新发现启动
    let mut m = state.lock().map_err(|e| e.to_string())?;
    m.stop_all_native();
    // 迁移：复制旧目录全部子目录（含 _core）到新目录，旧目录进回收站
    std::fs::create_dir_all(&new).map_err(|e| format!("创建插件目录失败: {e}"))?;
    if old.is_dir() {
        let read = std::fs::read_dir(&old).map_err(|e| format!("读取插件目录失败: {e}"))?;
        for entry in read.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let dst = new.join(&name);
            let _ = std::fs::remove_dir_all(&dst);
            copy_dir_recursive(&dir, &dst).map_err(|e| format!("迁移插件 {name} 失败: {e}"))?;
        }
        // 旧目录进回收站（可反悔）；失败只告警不阻断（新目录已就绪）
        let _ = trash::delete(&old);
    }
    save_state_map(&app, &map)?;
    // 迁移后：按已配置工作区重新发现（native 会随启用状态重新启动）
    if let Some(v) = m.vault.clone() {
        let _ = m.refresh(&app, &v);
    }
    Ok(new.to_string_lossy().to_string())
}

/// 在解包目录中定位插件清单：根 plugin.json，或唯一子目录下的 plugin.json
/// （常见打包结构 `<id>/plugin.json` + DLL）。
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

/// 统一插件命令调用的共享实现（去重：`plugins_invoke` 与 `plugin_call` 历史双命名，
/// 逻辑完全相同，收敛到此处）。native → FFI；process → JSON-RPC；webview → 拒绝。
fn invoke_plugin(
    app: &tauri::AppHandle,
    state: &State<'_, Mutex<PluginManager>>,
    vault: &str,
    id: &str,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(app, vault)?;
    let mut m = state.lock().map_err(|e| e.to_string())?;
    ensure_refreshed(&mut m, app, vault)?;
    m.invoke(id, command, args)
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
    invoke_plugin(&app, &state, &vault, &id, &command, args)
}

/// 统一插件命令调用（任何 runtime）：native → FFI；process → JSON-RPC；
/// webview → 拒绝（由前端注册表调用）。核心插件（如 notes）走这里。
#[tauri::command]
pub async fn plugin_call(
    app: tauri::AppHandle,
    state: State<'_, Mutex<PluginManager>>,
    vault: String,
    id: String,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    invoke_plugin(&app, &state, &vault, &id, &command, args)
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

