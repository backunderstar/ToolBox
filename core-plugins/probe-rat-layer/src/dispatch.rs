//! 命令分发 + 后台任务引擎 + 状态恢复（对应 Python `main.py` 的壳与状态机）。
//!
//! 命令集与 Python 版完全一致（`layer.listDir/config/run/status/cancel/result/readOut/
//! render/openOut/report/notifyDone/plugin.action`）。native 插件在宿主进程内运行，
//! `LayerState::Drop` 在 `tb_destroy` 前取消并 join 后台线程，避免 use-after-free。

use crate::cancel::new_cancel;
use crate::config::{default_config, LayeringConfig};
use crate::io::{load_input, LoadedData};
use crate::model::{KeepoutZone, LayeringResult, Wire};
use crate::pipeline;
use crate::report;
use crate::state::{ActiveStateData, Progress};
use crate::viz;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tb_sdk::TbHostApi;

const PLUGIN_ID: &str = "probe-rat-layer";

/// 后台线程 emit 用：宿主回调表 + ctx（`*mut c_void` 非 Send，但线程在 `tb_destroy`
/// 前 join，安全；unsafe 标记确认）。
struct EmitHandle {
    host: TbHostApi,
    ctx: *mut std::ffi::c_void,
}
unsafe impl Send for EmitHandle {}

/// 任务记录（已完成/进行中任务的元数据）。
#[derive(Debug, Clone, Default)]
struct JobRecord {
    summary: Option<Value>,
    layers_detail: Vec<Value>,
    out_dir: Option<String>,
    files: Vec<String>,
}

pub struct LayerState {
    vault: String,
    /// 文件输入（Inbox，数据根/Input）目录：插件可**只读**它（浏览/读入 pin 表等）；
    /// 输出仍限当前工作区。空串 = 未配置数据根。
    input_dir: String,
    /// 插件自己的工作目录（jobs/cache/settings 落地处）= config_dir/probe-rat-layer
    plugin_dir: String,
    active: Arc<Mutex<ActiveStateData>>,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
    running: Arc<Mutex<Option<JoinHandle<()>>>>,
}

impl LayerState {
    fn plugin_dir(config_dir: &str) -> String {
        let base = if config_dir.is_empty() { "." } else { config_dir };
        format!("{}/{}", base.trim_end_matches(['/', '\\']), PLUGIN_ID)
    }

    fn job_dir(&self, job_id: &str) -> String {
        format!("{}/jobs/{job_id}", self.plugin_dir)
    }

    fn set_active(&self, state: &str, stage: &str, percent: f64, message: &str, error: Option<String>) {
        if let Ok(mut s) = self.active.lock() {
            s.state = state.to_string();
            s.stage = stage.to_string();
            s.percent = percent;
            s.message = message.to_string();
            s.error = error;
        }
    }

    fn spawn_run(&mut self, host: TbHostApi, ctx: *mut std::ffi::c_void, job_id: String, args: Value) {
        let active = Arc::clone(&self.active);
        let cancel = Arc::clone(&self.cancel);
        let jobs = Arc::clone(&self.jobs);
        let plugin_dir = self.plugin_dir.clone();
        let workspace = self.vault.clone();
        let input_dir = self.input_dir.clone();
        let eh = EmitHandle { host, ctx };
        let handle = std::thread::Builder::new()
            .spawn(move || {
                _run_job(eh, &plugin_dir, &workspace, &input_dir, job_id, args, &active, &cancel, &jobs);
            })
            .ok();
        *self.running.lock().unwrap() = handle;
    }

    fn restore_jobs(&self) {
        let jobs_dir = format!("{}/jobs", self.plugin_dir);
        if !std::path::Path::new(&jobs_dir).is_dir() {
            return;
        }
        let mut names: Vec<String> = std::fs::read_dir(&jobs_dir)
            .map(|rd| rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).collect())
            .unwrap_or_default();
        names.sort();
        names.reverse();
        let mut restored: Vec<String> = Vec::new();
        let mut map = self.jobs.lock().unwrap();
        for name in names {
            let mpath = format!("{jobs_dir}/{name}/meta.json");
            if !std::path::Path::new(&mpath).is_file() {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&mpath) else { continue };
            let Ok(meta) = serde_json::from_str::<Value>(&content) else { continue };
            map.insert(
                name.clone(),
                JobRecord {
                    summary: meta.get("summary").cloned(),
                    layers_detail: meta
                        .get("layers_detail")
                        .and_then(|v| v.as_array())
                        .map(|a| a.to_vec())
                        .unwrap_or_default(),
                    out_dir: meta.get("out_dir").and_then(|v| v.as_str()).map(str::to_string),
                    files: meta
                        .get("files")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                },
            );
            restored.push(name);
        }
        drop(map);
        if let Some(first) = restored.first() {
            let job_id = first.clone();
            self.set_active("done", "完成", 100.0, "完成", None);
            if let Ok(mut s) = self.active.lock() {
                s.job_id = Some(job_id);
            }
        }
    }
}

impl Drop for LayerState {
    fn drop(&mut self) {
        // 取消并 join 后台线程，确保 `tb_destroy` 返回前线程已终止（DLL 安全卸载）。
        self.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(h) = self.running.lock().unwrap().take() {
            let _ = h.join();
        }
    }
}

pub fn state_from_cfg(cfg: &Value) -> Result<LayerState, String> {
    let vault = cfg.get("vault").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let input_dir = cfg.get("input_dir").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let config_dir = cfg.get("config_dir").and_then(|v| v.as_str()).unwrap_or("").to_string();
    // 容忍空 vault：与 Python 版一致——插件启动不受工作区配置影响，需要工作区的命令在
    // 调用期报"工作区目录无效"。jobs/cache/settings 落在 config_dir/probe-rat-layer。
    let plugin_dir = LayerState::plugin_dir(&config_dir);
    let _ = std::fs::create_dir_all(&plugin_dir);
    let state = LayerState {
        vault,
        input_dir,
        plugin_dir,
        active: Arc::new(Mutex::new(ActiveStateData::default())),
        cancel: new_cancel(),
        jobs: Arc::new(Mutex::new(HashMap::new())),
        running: Arc::new(Mutex::new(None)),
    };
    state.restore_jobs();
    Ok(state)
}

pub fn call(
    state: &mut LayerState,
    host: TbHostApi,
    ctx: *mut std::ffi::c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    // native 插件契约：`method` = 命令名（layer.render 等），`params` = 该命令的参数对象。
    match method {
        "layer.listDir" => cmd_list_dir(
            &state.vault,
            &state.input_dir,
            params.get("path").and_then(|v| v.as_str()),
        ),
        "layer.config" => cmd_config(state, &params),
        "layer.run" => cmd_run(state, host, ctx, &params),
        "layer.status" => cmd_status(state),
        "layer.cancel" => cmd_cancel(state),
        "layer.result" => cmd_result(state, &params),
        "layer.report" => cmd_report(state, &params),
        "layer.readOut" => cmd_read_out(state, &params),
        "layer.render" => cmd_render(state, &params),
        "layer.openOut" => cmd_open_out(state, host, ctx, &params),
        "layer.notifyDone" => cmd_notify_done(host, ctx, &params),
        "plugin.action" => cmd_plugin_action(state, &params),
        _ => Err(format!("未知命令: {method}")),
    }
}

// ---------- 文件浏览 / 设置 ----------

/// 把请求路径钳制到**可读根集合**内的绝对路径：空路径/越界路径 → 工作区根；否则
/// 返回落在工作区或文件输入（Input）目录内的绝对路径。工作区外的路径一律拒绝
/// （文件操作只允许在当前工作区内；文件输入目录仅作为**只读**根，供浏览/读入待处理
/// 文件，如 Allegro pin 表）。两个根都空（未配置）→ 空串，由调用方报"未配置"。
fn clamp_to_roots(workspace: &str, input_dir: &str, p: &str) -> String {
    let p = p.trim();
    if p.is_empty() {
        return workspace.to_string();
    }
    let abs = if std::path::Path::new(p).is_absolute() {
        p.to_string()
    } else {
        std::path::Path::new(workspace).join(p).to_string_lossy().to_string()
    };
    for root in [workspace, input_dir] {
        if root.is_empty() {
            continue;
        }
        let ws = std::fs::canonicalize(root).ok();
        let ab = std::fs::canonicalize(&abs).ok();
        if let (Some(ws), Some(ab)) = (ws, ab) {
            if ab == ws || ab.starts_with(&ws) {
                return abs;
            }
        }
    }
    // 目标不存在（如正待选目录）：仍按其绝对形式，交由调用方报"目录不存在"
    if std::fs::canonicalize(&abs).is_err() {
        return abs;
    }
    workspace.to_string()
}

/// 路径是否落在工作区内（用于命令校验；工作区未配置时放行，便于开发/旧数据）。
fn within_workspace(workspace: &str, p: &str) -> bool {
    if workspace.is_empty() {
        return true;
    }
    let ws = std::fs::canonicalize(workspace).unwrap_or_else(|_| std::path::PathBuf::from(workspace));
    let joined = if std::path::Path::new(p).is_absolute() {
        std::path::PathBuf::from(p)
    } else {
        std::path::Path::new(workspace).join(p)
    };
    let ab = std::fs::canonicalize(&joined).unwrap_or(joined);
    ab == ws || ab.starts_with(&ws)
}

/// 路径是否落在**可读根集合**内（工作区 或 文件输入目录）。输入只读、输出限工作区：
/// `_run_job` 据此校验 input（可读根）与 out_dir（仅工作区，`within_workspace`）。
fn within_read(workspace: &str, input_dir: &str, p: &str) -> bool {
    within_workspace(workspace, p)
        || if input_dir.is_empty() {
            false
        } else {
            let root = std::fs::canonicalize(input_dir).unwrap_or_else(|_| std::path::PathBuf::from(input_dir));
            let joined = if std::path::Path::new(p).is_absolute() {
                std::path::PathBuf::from(p)
            } else {
                std::path::Path::new(input_dir).join(p)
            };
            let ab = std::fs::canonicalize(&joined).unwrap_or(joined);
            ab == root || ab.starts_with(&root)
        }
}

fn cmd_list_dir(workspace: &str, input_dir: &str, path: Option<&str>) -> Result<Value, String> {
    let target = clamp_to_roots(workspace, input_dir, path.unwrap_or(""));
    if target.is_empty() {
        return Err("未配置工作区/文件输入目录（请先在设置页选择/新建工作区）".to_string());
    }
    if !std::path::Path::new(&target).is_dir() {
        return Err(format!("目录不存在: {target}"));
    }
    let mut entries: Vec<Value> = Vec::new();
    let rd = std::fs::read_dir(&target).map_err(|e| format!("无法读取目录: {e}"))?;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = if is_dir {
            None
        } else {
            e.metadata().ok().map(|m| m.len())
        };
        entries.push(json!({"name": name, "isDir": is_dir, "size": size}));
    }
    entries.sort_by(|a, b| {
        let ad = a["isDir"].as_bool().unwrap_or(false);
        let bd = b["isDir"].as_bool().unwrap_or(false);
        bd.cmp(&ad).then(a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()))
    });
    Ok(json!(entries))
}

fn settings_path(dir: &str) -> String {
    format!("{dir}/settings.json")
}

fn cmd_config(state: &LayerState, args: &Value) -> Result<Value, String> {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("get");
    let path = settings_path(&state.plugin_dir);
    if action == "get" {
        let settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({}));
        return Ok(json!({"settings": settings}));
    }
    if action == "set" {
        let cur = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({}));
        let mut obj = cur.as_object().cloned().unwrap_or_default();
        if let Some(patch) = args.get("patch").and_then(|p| p.as_object()) {
            for (k, v) in patch {
                obj.insert(k.clone(), v.clone());
            }
        }
        let text = serde_json::to_string_pretty(&Value::Object(obj)).map_err(|e| e.to_string())?;
        std::fs::write(&path, &text).map_err(|e| format!("写入设置失败: {e}"))?;
        return Ok(json!({"settings": serde_json::from_str::<Value>(&text).unwrap_or(json!({}))}));
    }
    Err(format!("未知 action: {action}"))
}

// ---------- 后台任务 ----------

fn cmd_run(state: &mut LayerState, host: TbHostApi, ctx: *mut std::ffi::c_void, args: &Value) -> Result<Value, String> {
    let state_lock = state.active.lock().unwrap();
    if state_lock.state == "running" {
        return Err("已有任务在运行，请先等待或取消".to_string());
    }
    drop(state_lock);
    let job_id = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
    state.set_active("running", "启动", 0.0, "启动", None);
    // 关键：`layer.status` 返回 `active.job_id`，必须同步为当前任务。
    // 否则（恢复过旧任务时）status 会一直返回旧 jobId，前端 `layer.result` 就取到上一次结果。
    if let Ok(mut a) = state.active.lock() {
        a.job_id = Some(job_id.clone());
    }
    state.jobs.lock().unwrap().insert(job_id.clone(), JobRecord::default());
    state.spawn_run(host, ctx, job_id.clone(), args.clone());
    Ok(json!({"jobId": job_id}))
}

fn cmd_status(state: &LayerState) -> Result<Value, String> {
    let s = state.active.lock().unwrap();
    Ok(json!({
        "state": s.state,
        "jobId": s.job_id,
        "stage": s.stage,
        "percent": s.percent,
        "message": s.message,
        "error": s.error,
    }))
}

fn cmd_cancel(state: &LayerState) -> Result<Value, String> {
    let active = state.active.lock().unwrap();
    let has_job = active.state == "running";
    drop(active);
    if has_job {
        state.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(json!({"ok": true}))
    } else {
        Ok(json!({"ok": false, "message": "没有正在运行的任务"}))
    }
}

fn _run_job(
    eh: EmitHandle,
    plugin_dir: &str,
    workspace: &str,
    input_dir: &str,
    job_id: String,
    args: Value,
    active: &Arc<Mutex<ActiveStateData>>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
    jobs: &Arc<Mutex<HashMap<String, JobRecord>>>,
) {
    let prog = Progress::new(active, cancel);
    let started = std::time::Instant::now();
    let emit = |event: &str, data: Value| {
        let host = eh.host;
        tb_sdk::emit(host, eh.ctx, event, data);
    };
    let result = (|| -> Result<LayeringResult, String> {
        let input = args.get("input").and_then(|v| v.as_str()).unwrap_or("");
        let filter = args.get("filter").and_then(|v| v.as_str()).map(str::to_string);
        let out_dir = args.get("outDir").and_then(|v| v.as_str()).unwrap_or("");
        // 文件操作：输入限**可读根**（当前工作区 或 文件输入目录），输出限当前工作区
        // （用户要求：输出落地在工作区；输入可从 Input 读待处理文件，如 Allegro pin 表）。
        if !within_read(workspace, input_dir, input) {
            return Err("输入文件越出可读范围（需在当前工作区或文件输入目录内）".to_string());
        }
        if !within_workspace(workspace, out_dir) {
            return Err("输出目录越出工作区（文件输出限定在当前工作区内）".to_string());
        }
        if input.is_empty() || !std::path::Path::new(input).is_file() {
            return Err(format!("输入文件不存在: {input}"));
        }
        if out_dir.is_empty() {
            return Err("未指定输出目录（必填）".to_string());
        }
        std::fs::create_dir_all(out_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;

        prog.set("读入输入", 2.0, "读入输入");
        let data: LoadedData = load_input(
            input,
            filter.as_deref(),
            args.get("layers").and_then(|v| v.as_i64()).unwrap_or(4),
            args.get("width").and_then(|v| v.as_f64()).unwrap_or(0.2),
            args.get("clearance").and_then(|v| v.as_f64()).unwrap_or(0.2),
        )?;

        prog.set("配置", 4.0, "配置");
        let mut cfg = default_config();
        if let Some(ov) = args.get("config") {
            cfg = cfg.with_overrides(ov)?;
        }
        for fld in ["resolve_conflict_rounds", "balance_length_rounds", "minimize_crossings_passes", "sa_restarts"] {
            if let Some(v) = args.get(fld).and_then(|x| x.as_i64()) {
                set_int_field(&mut cfg, fld, v);
            }
        }

        let result = pipeline::run(&data, &cfg, None, &prog)
            .map_err(|_| "已取消".to_string())?;

        prog.set("导出结果", 94.0, "导出结果");
        let rep = report::build_report(&result, &cfg);
        report::write_report(&rep, out_dir)?;
        report::export_layer_nets(&result, out_dir)?;
        report::export_layer_nets_lst(&result, out_dir)?;
        report::export_manual_route_lst(&result, out_dir)?;
        report::export_net_layer_csv(&result, out_dir)?;
        report::export_layer_statistics_csv(&result, out_dir)?;

        // 存供渲染用的精简几何/结果数据（jobs/<jobId>/）
        let jdir = format!("{plugin_dir}/jobs/{job_id}");
        std::fs::create_dir_all(&jdir).map_err(|e| e.to_string())?;
        let geo = json!({
            "cfg": cfg.to_json(),
            "wires": data.wires.iter().map(serialize_wire).collect::<Vec<_>>(),
            "keepouts": data.keepouts.iter().map(serialize_keepout).collect::<Vec<_>>(),
        });
        std::fs::write(format!("{jdir}/geometry.json"), serde_json::to_string(&geo).unwrap_or_default())
            .map_err(|e| e.to_string())?;
        let res = json!({
            "layers": result.layers.iter().map(|li| json!({
                "layer": li.layer_index,
                "kind": li.kind,
                "wires": li.wires,
                "nets": li.nets,
                "soft_conflict_count": li.soft_conflict_count,
                "max_occupancy": li.max_occupancy,
            })).collect::<Vec<_>>(),
            "summary": summary_json(&result),
            "manual_route_nets": result.manual_route_nets,
            "plane_nets": result.plane_nets,
        });
        std::fs::write(format!("{jdir}/result.json"), serde_json::to_string(&res).unwrap_or_default())
            .map_err(|e| e.to_string())?;

        Ok(result)
    })();

    match result {
        Ok(result) => {
            let elapsed = started.elapsed().as_secs_f64();
            let summary = summary_ext(&result, elapsed); // 含 elapsed_sec，供结果页/通知一致展示
            let layers_detail: Vec<Value> = result
                .layers
                .iter()
                .map(|li| {
                    json!({
                        "layer": li.layer_index,
                        "kind": li.kind,
                        "net_count": li.nets.len(),
                        "wire_count": li.wires.len(),
                        "soft_conflict_count": li.soft_conflict_count,
                        "max_occupancy": li.max_occupancy,
                    })
                })
                .collect();
            {
                let mut jr = jobs.lock().unwrap();
                let rec = jr.entry(job_id.clone()).or_default();
                rec.summary = Some(summary.clone());
                rec.layers_detail = layers_detail.clone();
                rec.out_dir = Some(args.get("outDir").and_then(|v| v.as_str()).unwrap_or("").to_string());
                rec.files = list_out_files(args.get("outDir").and_then(|v| v.as_str()).unwrap_or(""));
            }
            {
                let mut s = active.lock().unwrap();
                s.state = "done".to_string();
                s.stage = "完成".to_string();
                s.percent = 100.0;
                s.message = "完成".to_string();
                s.error = None;
            }
            let jdir = format!("{plugin_dir}/jobs/{job_id}");
            let meta = json!({
                "summary": summary,
                "layers_detail": layers_detail,
                "out_dir": args.get("outDir").and_then(|v| v.as_str()).unwrap_or(""),
                "files": list_out_files(args.get("outDir").and_then(|v| v.as_str()).unwrap_or("")),
            });
            let _ = std::fs::write(format!("{jdir}/meta.json"), serde_json::to_string(&meta).unwrap_or_default());
            emit("layer.done", json!({"jobId": job_id, "summary": summary}));
        }
        Err(_e) => {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                // 取消
                let mut s = active.lock().unwrap();
                s.state = "cancelled".to_string();
                s.stage = "已取消".to_string();
                s.percent = 0.0;
                s.message = "已取消".to_string();
                s.error = None;
                emit("layer.cancelled", json!({"jobId": job_id}));
            } else {
                let mut s = active.lock().unwrap();
                s.state = "failed".to_string();
                s.stage = "失败".to_string();
                s.percent = 0.0;
                s.message = "失败".to_string();
                s.error = Some(_e.clone());
                emit("layer.failed", json!({"jobId": job_id, "error": _e.clone()}));
            }
        }
    }
}

// ---------- 结果读取 ----------

fn cmd_result(state: &LayerState, args: &Value) -> Result<Value, String> {
    let job_id = args.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    let jobs = state.jobs.lock().unwrap();
    let rec = jobs.get(job_id).ok_or_else(|| format!("任务不存在: {job_id}"))?;
    let summary = rec.summary.clone().ok_or_else(|| {
        let st = state.active.lock().unwrap();
        format!("任务 {job_id} 无结果（状态: {}）", st.state)
    })?;
    Ok(json!({
        "summary": summary,
        "layers": rec.layers_detail,
        "outDir": rec.out_dir,
        "files": rec.files,
    }))
}

fn cmd_report(state: &LayerState, args: &Value) -> Result<Value, String> {
    let job_id = args.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    let jobs = state.jobs.lock().unwrap();
    let rec = jobs.get(job_id).ok_or_else(|| format!("任务不存在: {job_id}"))?;
    let out_dir = rec.out_dir.clone().ok_or("任务无输出目录")?;
    let path = format!("{}/json/report.json", out_dir.trim_end_matches(['/', '\\']));
    if !std::path::Path::new(&path).is_file() {
        return Err("report.json 不存在".to_string());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut rep: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    if let Some(conflicts) = rep.get_mut("conflicts").and_then(|c| c.as_object_mut()) {
        for level in ["hard", "soft"] {
            if let Some(items) = conflicts.get_mut(level).and_then(|a| a.as_array_mut()) {
                if items.len() > 300 {
                    *items = items[..300].to_vec();
                    conflicts.insert(format!("{level}_truncated"), json!(true));
                }
            }
        }
    }
    let text = serde_json::to_string_pretty(&rep).map_err(|e| e.to_string())?;
    if text.len() > 4 * 1024 * 1024 {
        return Err("report.json 过大，无法在线预览（请用「打开输出目录」查看）".to_string());
    }
    Ok(json!({"text": text}))
}

fn cmd_read_out(state: &LayerState, args: &Value) -> Result<Value, String> {
    let job_id = args.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    let rel = args.get("rel").and_then(|v| v.as_str()).unwrap_or("");
    let jobs = state.jobs.lock().unwrap();
    let rec = jobs.get(job_id).ok_or_else(|| format!("任务不存在: {job_id}"))?;
    let out_dir = rec.out_dir.clone().ok_or("任务无输出目录")?;
    let target = normalize_join(&out_dir, rel)?;
    if !std::path::Path::new(&target).is_file() {
        return Err(format!("文件不存在: {rel}"));
    }
    let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    if size > 4 * 1024 * 1024 {
        return Err(format!("文件过大（{size} 字节，上限 4MB）: {rel}"));
    }
    let content = std::fs::read_to_string(&target).map_err(|e| e.to_string())?;
    Ok(json!(content))
}

fn normalize_join(root: &str, rel: &str) -> Result<String, String> {
    let root_p = std::path::Path::new(root);
    let target = root_p.join(rel);
    let norm = std::path::Path::new(&target).canonicalize().unwrap_or(target.clone());
    let root_canon = root_p.canonicalize().unwrap_or_else(|_| root_p.to_path_buf());
    if !norm.starts_with(&root_canon) {
        return Err(format!("路径越界: {rel}"));
    }
    Ok(norm.to_string_lossy().to_string())
}

// ---------- 渲染（M7 完全实现）----------

fn cmd_render(state: &LayerState, args: &Value) -> Result<Value, String> {
    let job_id = args.get("jobId").and_then(|v| v.as_str()).unwrap_or("");
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    viz::render(&state.plugin_dir, job_id, kind)
}

fn cmd_open_out(state: &LayerState, host: TbHostApi, ctx: *mut std::ffi::c_void, args: &Value) -> Result<Value, String> {
    let out_dir = args.get("outDir").and_then(|v| v.as_str()).unwrap_or("");
    if out_dir.is_empty() || !std::path::Path::new(out_dir).is_dir() {
        return Err(format!("目录不存在: {out_dir}"));
    }
    let _ = state;
    open_path(host, ctx, out_dir)?;
    Ok(json!({"ok": true}))
}

fn cmd_notify_done(host: TbHostApi, ctx: *mut std::ffi::c_void, args: &Value) -> Result<Value, String> {
    let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("探针卡分层");
    let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("任务完成");
    tb_sdk::emit(host, ctx, "notification", json!({"title": title, "body": body}));
    Ok(json!({"ok": true}))
}

fn open_path(host: TbHostApi, ctx: *mut std::ffi::c_void, path: &str) -> Result<(), String> {
    let Some(f) = host.open_path else {
        return Err("宿主未就绪（open_path 不可用）".to_string());
    };
    let cstr = std::ffi::CString::new(path).map_err(|_| "路径含 NUL".to_string())?;
    let _ = ctx;
    let code = unsafe { f(std::ptr::null_mut(), cstr.as_ptr()) };
    if code != 0 {
        return Err(format!("打开失败（{path}）"));
    }
    Ok(())
}

// ---------- 插件文件上下文动作 ----------

fn _safe_join(workspace: &str, rel: &str) -> Option<String> {
    let root = std::path::Path::new(workspace).canonicalize().ok();
    let joined = std::path::Path::new(workspace).join(rel);
    let norm = joined.canonicalize().unwrap_or(joined);
    let root = root?;
    if norm != root && !norm.starts_with(&root) {
        return None;
    }
    Some(norm.to_string_lossy().to_string())
}

fn cmd_plugin_action(state: &LayerState, args: &Value) -> Result<Value, String> {
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let files: Vec<String> = args
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let workspace = state.vault.clone();
    if source != "file" {
        return Ok(json!({"ok": true, "message": format!("忽略非文件来源动作: {source}")}));
    }
    if workspace.is_empty() || !std::path::Path::new(&workspace).is_dir() {
        return Err(format!("工作区目录无效: {workspace}"));
    }
    if action == "init-project-structure" {
        let mut created = Vec::new();
        for d in ["01-原始数据", "02-报告", "03-归档"] {
            let p = format!("{}/{d}", workspace.trim_end_matches(['/', '\\']));
            if !std::path::Path::new(&p).is_dir() {
                std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
                created.push(d);
            }
        }
        return Ok(json!({"ok": true, "created": created}));
    }
    if action == "archive-to-batch" {
        let batch = format!(
            "{}/03-归档/{}",
            workspace.trim_end_matches(['/', '\\']),
            chrono::Local::now().format("%Y%m%d")
        );
        std::fs::create_dir_all(&batch).map_err(|e| e.to_string())?;
        let mut moved = Vec::new();
        for rel in &files {
            let Some(src) = _safe_join(&workspace, rel) else {
                continue;
            };
            if !std::path::Path::new(&src).exists() {
                continue;
            }
            let base = std::path::Path::new(&src)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            let mut dst = format!("{batch}/{base}");
            if std::path::Path::new(&dst).exists() {
                let ts = chrono::Local::now().format("%H%M%S");
                dst = format!("{batch}/{ts}_{base}");
            }
            std::fs::rename(&src, &dst).map_err(|e| format!("移动失败: {e}"))?;
            moved.push(rel.clone());
        }
        let rel_batch = std::path::Path::new(&batch)
            .strip_prefix(&workspace)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(batch);
        return Ok(json!({"ok": true, "moved": moved, "batch": rel_batch}));
    }
    Ok(json!({"ok": true, "message": format!("未实现动作: {action}")}))
}

// ---------- 序列化 / 工具 ----------

fn serialize_wire(w: &Wire) -> Value {
    json!({
        "wire_id": w.wire_id,
        "net_id": w.net_id,
        "start": [w.start.x, w.start.y],
        "end": [w.end.x, w.end.y],
        "width": w.width,
        "clearance": w.clearance,
    })
}

fn serialize_keepout(z: &KeepoutZone) -> Value {
    match z {
        KeepoutZone::Rect(r) => json!({
            "type": "rect",
            "zone_id": r.zone_id,
            "xmin": r.xmin, "ymin": r.ymin, "xmax": r.xmax, "ymax": r.ymax,
        }),
        KeepoutZone::Circle(c) => json!({
            "type": "circle",
            "zone_id": c.zone_id,
            "center": [c.center.x, c.center.y],
            "radius": c.radius,
        }),
    }
}

fn list_out_files(out_dir: &str) -> Vec<String> {
    let mut found = Vec::new();
    fn walk(dir: &str, out_dir: &str, found: &mut Vec<String>) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p.to_string_lossy().to_string(), out_dir, found);
                } else {
                    let rel = p
                        .to_string_lossy()
                        .strip_prefix(out_dir)
                        .map(|s| s.trim_start_matches(['/', '\\']).replace('\\', "/"))
                        .unwrap_or_else(|| p.to_string_lossy().to_string());
                    found.push(rel);
                }
            }
        }
    }
    if !out_dir.is_empty() {
        walk(out_dir, out_dir, &mut found);
    }
    found.sort();
    found
}

fn summary_json(r: &LayeringResult) -> Value {
    json!({
        "method": r.method,
        "layer_count": r.layers.len(),
        "wire_assigned_count": r.assignment.len(),
        "plane_net_count": r.plane_nets.len(),
        "hard_conflict_count": r.hard_conflicts.len(),
        "soft_conflict_count": r.soft_conflicts.len(),
        "manual_route_net_count": r.manual_route_nets.len(),
        "manual_route_nets": r.manual_route_nets,
        "routable_net_count": r.routable_net_count,
        "total_net_count": r.total_net_count,
        "routable_ratio": if r.total_net_count > 0 {
            (r.routable_net_count as f64 / r.total_net_count as f64 * 10000.0).round() / 10000.0
        } else {
            0.0
        },
        "unroutable_nets": r.unroutable_nets,
        "routable_path_net_count": r.routable_path_net_count,
        "routable_path_ratio": if r.total_net_count > 0 {
            (r.routable_path_net_count as f64 / r.total_net_count as f64 * 10000.0).round() / 10000.0
        } else {
            0.0
        },
        "unroutable_nets_path": r.unroutable_nets_path,
        "multi_layer_nets": r.multi_layer_nets,
        "via_estimate": r.via_estimate,
        "iterations_used": r.iterations_used,
        "warnings": r.warnings,
        "capacity_lower_bound": r.capacity_lower_bound,
    })
}

fn summary_ext(r: &LayeringResult, elapsed: f64) -> Value {
    let mut v = summary_json(r);
    if let Some(o) = v.as_object_mut() {
        o.insert("elapsed_sec".to_string(), json!(elapsed));
    }
    v
}

fn set_int_field(cfg: &mut LayeringConfig, field: &str, v: i64) {
    match field {
        "resolve_conflict_rounds" => cfg.resolve_conflict_rounds = v,
        "balance_length_rounds" => cfg.balance_length_rounds = v,
        "minimize_crossings_passes" => cfg.minimize_crossings_passes = v,
        "sa_restarts" => cfg.sa_restarts = v,
        _ => {}
    }
}
