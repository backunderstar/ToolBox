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
use tauri::{Manager, State};

/// 目录修改类操作（install/uninstall/reinstall_core/plugins_dir_set）后立即更新
/// last_snapshot：这些操作已 scan/refresh 过，若不更新快照，下一次 ensure_refreshed
/// 会因快照不一致而全量重启所有 process 插件（无谓的启停抖动）。
fn sync_snapshot(m: &mut PluginManager, app: &tauri::AppHandle) -> Result<(), String> {
    let global = global_plugins_dir(app)?;
    m.last_snapshot = Some(plugins_snapshot(&global));
    Ok(())
}

/// 插件日志统一通道（webview 插件 / 插件自带前端 UI 用；process 用核心 API log，
/// native 用 TbHostApi::log）。来源前缀 [plugin:<id>]，按 level 分级落盘。
#[tauri::command]
pub fn plugin_log(plugin_id: String, level: String, message: String) -> Result<(), String> {
    if !is_safe_plugin_id(&plugin_id) {
        return Err(format!("非法插件 id: {plugin_id}"));
    }
    let line = format!("[plugin:{plugin_id}] {message}");
    match level.as_str() {
        "debug" => crate::core::log::debug(&line),
        "warn" => crate::core::log::warn(&line),
        "error" => crate::core::log::error(&line),
        _ => crate::core::log::info(&line),
    }
    Ok(())
}

/// 所有 async 命令的阻塞体统一模式：插件扫描/启动/调用是重活（目录扫描、
/// native FFI、process JSON-RPC 最长 30s、ai.chat 120s），必须放阻塞线程池
/// （spawn_blocking）执行——Tauri async 命令共享一个 tokio runtime，直接同步
/// 阻塞会冻结全部事件与并行命令。闭包内经 `app.state()` 重新取锁（State 引用
/// 不能跨 await / 进 'static 闭包）。vault 校验很轻，留在命令外层尽早失败。
/// 当前工作区路径（插件**管理**命令的上下文：插件进程的 vault / TB_WORKSPACE）。
/// 插件管理（列表/启停/安装/卸载/依赖）是全局操作，不依赖前端选工作区；
/// 未配置数据根/未选工作区 → 空串（列表仍可管理，插件进程 vault 为空）。
fn current_vault(app: &tauri::AppHandle) -> String {
    crate::core::workspaces::current_workspace_path(app)
        .ok()
        .flatten()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn plugins_list(app: tauri::AppHandle) -> Result<Vec<PluginInfo>, String> {
    // 插件管理是全局操作（列表/启停/安装不依赖工作区）；插件进程上下文（vault/
    // TB_WORKSPACE）用当前工作区，见 current_vault。S1c 校验只保留在**调用**类命令
    // （plugins_invoke / plugin_call，插件执行可读写工作区文件）。
    let v = current_vault(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.ensure_refreshed(&app, &v)?;
        Ok(m.list())
    })
    .await
    .map_err(|e| format!("插件列表任务异常: {e}"))?
}

#[tauri::command]
pub async fn plugins_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let v = current_vault(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.ensure_refreshed(&app, &v)?;
        m.set_enabled(&app, &id, enabled)
    })
    .await
    .map_err(|e| format!("插件启停任务异常: {e}"))?
}

/// 卸载插件：停进程 + 清启用状态 + 删除插件目录。
#[tauri::command]
pub async fn plugins_uninstall(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let v = current_vault(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.ensure_refreshed(&app, &v)?;
        m.uninstall(&app, &id)?;
        sync_snapshot(&mut m, &app)
    })
    .await
    .map_err(|e| format!("插件卸载任务异常: {e}"))?
}

/// 重新安装已卸载的核心插件（从随应用分发的资源恢复）。
#[tauri::command]
pub async fn plugins_reinstall_core(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !is_safe_plugin_id(&id) {
        return Err(format!("非法插件 id: {id}"));
    }
    let v = current_vault(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.ensure_refreshed(&app, &v)?;
        m.reinstall_core(&app, &id)?;
        sync_snapshot(&mut m, &app)
    })
    .await
    .map_err(|e| format!("核心插件重装任务异常: {e}"))?
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
    source: String,
    kind: String,
) -> Result<String, String> {
    let v = current_vault(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.ensure_refreshed(&app, &v)?;
        let id = m.install(&app, &source, &kind)?;
        sync_snapshot(&mut m, &app)?;
        Ok(id)
    })
    .await
    .map_err(|e| format!("插件安装任务异常: {e}"))?
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
    // 迁移是重 IO（全量复制插件目录），放阻塞线程池
    let map2 = map.clone();
    let old2 = old.clone();
    let new2 = new.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        // 迁移前：停掉全部 native 插件（释放 DLL 文件锁），迁移后 refresh 重新发现启动
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.stop_all_native();
        // 迁移：复制旧目录全部子目录（含 _core）到新目录
        let migrate = || -> Result<(), String> {
            std::fs::create_dir_all(&new2).map_err(|e| format!("创建插件目录失败: {e}"))?;
            if old2.is_dir() {
                let read = std::fs::read_dir(&old2).map_err(|e| format!("读取插件目录失败: {e}"))?;
                for entry in read.flatten() {
                    let dir = entry.path();
                    if !dir.is_dir() {
                        continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_string();
                    let dst = new2.join(&name);
                    let _ = std::fs::remove_dir_all(&dst);
                    copy_dir_recursive(&dir, &dst)
                        .map_err(|e| format!("迁移插件 {name} 失败: {e}"))?;
                }
            }
            Ok(())
        };
        if let Err(e) = migrate() {
            // 迁移失败：配置尚未写（save_state_map 在迁移后），refresh 会用旧目录
            // 重启 native 插件，恢复迁移前的运行状态——不留"插件被停但目录没迁成"的坑
            if let Some(v) = m.vault.clone() {
                let _ = m.refresh(&app, &v);
            }
            return Err(format!("插件目录迁移失败: {e}"));
        }
        // 旧目录进回收站（可反悔）；失败只告警不阻断（新目录已就绪）
        if let Err(e) = trash::delete(&old2) {
            crate::core::log::error(&format!(
                "[plugins] 旧插件目录移入回收站失败（可手动清理 {old2:?}）: {e}"
            ));
        }
        save_state_map(&app, &map2)?;
        // 迁移后：按已配置工作区重新发现（native 会随启用状态重新启动）
        if let Some(v) = m.vault.clone() {
            let _ = m.refresh(&app, &v);
        }
        // 目录已迁移 + refresh，同步快照避免下一次 ensure_refreshed 全量重启
        sync_snapshot(&mut m, &app)?;
        Ok(new2.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("插件目录迁移任务异常: {e}"))?
}

/// 在解包目录中定位插件清单：根 plugin.json，或唯一子目录下的 plugin.json
/// （常见打包结构 `<id>/plugin.json` + DLL）。
#[tauri::command]
pub async fn plugins_reload(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let v = current_vault(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.ensure_refreshed(&app, &v)?;
        m.reload(&id)
    })
    .await
    .map_err(|e| format!("插件重载任务异常: {e}"))?
}

/// 插件依赖安装：用捆绑 Python 的 pip 把 `requirements.txt` 装进 `<插件>/vendor/`。
/// 目标机没有 Python 也能自助补依赖（捆绑运行时 full 变体带 pip；需有网）。
/// 返回 pip 输出尾部；成功后前端重载插件生效。
#[tauri::command]
pub async fn plugins_install_deps(app: tauri::AppHandle, id: String) -> Result<String, String> {
    // 安全（S1a）：id 会拼进插件目录路径
    if !is_safe_plugin_id(&id) {
        return Err(format!("非法插件 id: {id}"));
    }
    let v = current_vault(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.ensure_refreshed(&app, &v)?;
        m.install_deps(&app, &id)
    })
    .await
    .map_err(|e| format!("插件依赖安装任务异常: {e}"))?
}

/// 导出插件为 .zip 插件包（插件页「导出」；分享/备份）：dest = 用户选择的保存路径。
#[tauri::command]
pub async fn plugins_export(
    app: tauri::AppHandle,
    id: String,
    dest: String,
) -> Result<String, String> {
    if !is_safe_plugin_id(&id) {
        return Err(format!("非法插件 id: {id}"));
    }
    let v = current_vault(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        let mut m = state.lock().map_err(|e| e.to_string())?;
        m.ensure_refreshed(&app, &v)?;
        m.export_zip(&id, &dest)
    })
    .await
    .map_err(|e| format!("插件导出任务异常: {e}"))?
}

/// 插件 id 安全校验：小写字母/数字开头，仅含小写字母/数字/`-`/`_`。
/// 用于所有"id 拼进文件路径"的入口——拒绝 `..`、`/`、`\`、绝对路径等，
/// 防路径穿越（如 `id="../../.."` 把目录根引到任意位置后读取任意文件）。
#[tauri::command]
pub async fn plugins_read_file(app: tauri::AppHandle, id: String, rel: String) -> Result<String, String> {
    // 安全（S1a）：id 必须为合法插件名。历史漏洞——id 未校验就拼路径，
    // `id="../../.."` 会让候选 root 指向插件根之外任意**已存在**目录，
    // 此时 rel 只要不含非法组件即可读取该目录下任意文本文件。
    if !is_safe_plugin_id(&id) {
        return Err(format!("非法插件 id: {id}"));
    }
    // 文件读取放阻塞线程池（大文件/慢盘不冻结 tokio worker）
    tauri::async_runtime::spawn_blocking(move || {
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
                        // 与 resolve_safe 一致：拒绝 CurDir（rel="." 会读目录报错）
                        | std::path::Component::CurDir
                )
            });
        if bad {
            return Err(format!("非法路径: {rel}"));
        }
        let p = root.join(rel_path);
        if !p.starts_with(&root) {
            return Err(format!("路径越界: {rel}"));
        }
        // 最终防御：读取前 canonicalize 解析符号链接，确认解析后的真实路径仍
        // 在插件根内（插件目录里的符号链接不能把读取引到插件外任意文件）
        let p_canon = p.canonicalize().map_err(|e| format!("读取插件文件失败: {e}"))?;
        if !p_canon.starts_with(&root_canon) {
            return Err(format!("路径越界（符号链接）: {rel}"));
        }
        std::fs::read_to_string(&p_canon).map_err(|e| format!("读取插件文件失败: {e}"))
    })
    .await
    .map_err(|e| format!("插件文件读取任务异常: {e}"))?
}

#[tauri::command]
pub async fn plugins_invoke(
    app: tauri::AppHandle,
    vault: String,
    id: String,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let v = vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        invoke_plugin_locked(&app, &state, &v, &id, &command, args)
    })
    .await
    .map_err(|e| format!("插件命令任务异常: {e}"))?
}

/// 统一插件命令调用（任何 runtime）：native → FFI；process → JSON-RPC；
/// webview → 拒绝（由前端注册表调用）。核心插件（如 notes）走这里。
/// 插件命令最长可阻塞 120s（ai.chat 非流式）——调用方必须已在阻塞线程池。
#[tauri::command]
pub async fn plugin_call(
    app: tauri::AppHandle,
    vault: String,
    id: String,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    let v = vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        invoke_plugin_locked(&app, &state, &v, &id, &command, args)
    })
    .await
    .map_err(|e| format!("插件命令任务异常: {e}"))?
}

/// 统一插件命令调用的共享实现（去重：`plugins_invoke` 与 `plugin_call` 历史双命名，
/// 逻辑完全相同，收敛到此处）。native → FFI；process → JSON-RPC；webview → 拒绝。
/// 注意：本函数在锁内执行（PluginManager::invoke 需 &mut，进程句柄/序号要互斥），
/// 长调用（FFI / 30s RPC / 120s ai.chat）会持锁——调用方已用 spawn_blocking 保证
/// 不冻结 tokio runtime；锁竞争是插件系统串行调用模型的架构约束。
fn invoke_plugin_locked(
    app: &tauri::AppHandle,
    state: &State<'_, Mutex<PluginManager>>,
    vault: &str,
    id: &str,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut m = state.lock().map_err(|e| e.to_string())?;
    m.ensure_refreshed(app, vault)?;
    m.invoke(id, command, args)
}

/// 聚合搜索：宿主内嵌全文搜索（FTS，core::search）+ 所有启用的搜索提供者
/// 插件的 `search.provide` 命中（来源以 source 字段标记）。
#[tauri::command]
pub async fn search_all(
    app: tauri::AppHandle,
    vault: String,
    query: String,
) -> Result<serde_json::Value, String> {
    // 安全（S1c）：vault 必须等于已配置工作区，否则插件命令可把文件作用域
    // 指向任意目录（读任意文件夹/写任意位置）。校验失败直接拒绝。
    crate::core::vault::ensure_vault_matches(&app, &vault)?;
    // 整个聚合（FTS 线程 join + 提供者 30s 超时调用）放阻塞线程池，避免 tokio 冻结
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<PluginManager>>();
        // 锁内只做"刷新 + 收集提供者列表"（快）；FTS 与提供者聚合都在锁外执行
        let providers: Vec<String> = {
            let mut m = state.lock().map_err(|e| e.to_string())?;
            m.ensure_refreshed(&app, &vault)?;
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
        let fts_handle =
            std::thread::spawn(move || crate::core::search::search(&fts_vault, &fts_query));

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
            Ok(Err(e)) => crate::core::log::error(&format!("[search] 全文搜索失败: {e}")),
            Err(_) => crate::core::log::error("[search] 全文搜索线程异常"),
        }
        hits.extend(provider_hits);
        Ok(Value::Array(hits))
    })
    .await
    .map_err(|e| format!("搜索任务异常: {e}"))?
}

