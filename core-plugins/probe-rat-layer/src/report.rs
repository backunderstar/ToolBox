//! JSON 报告 + 文本摘要 + 层→net 导出（移植自 Python `probe_layer/report.py`）。

use crate::config::LayeringConfig;
use crate::model::{Conflict, LayeringResult};
use serde_json::{json, Value};

const VERSION: &str = "0.2.0";

fn now_iso() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn conflict_to_json(c: &Conflict) -> Value {
    json!({
        "wire_a": c.wire_a,
        "wire_b": c.wire_b,
        "level": c.level.as_str(),
        "intersect_pt": c.intersect_pt.map(|p| json!({"x": p.x, "y": p.y})),
        "clearance_gap": round6(c.clearance_gap),
        "dist_to_endpoints": [round6(c.dist_to_endpoints.0), round6(c.dist_to_endpoints.1)],
        "keepout_ids": c.keepout_ids,
        "congestion": round4(c.congestion),
        "reasons": c.reasons,
    })
}

fn round6(x: f64) -> f64 {
    (x * 1_000_000.0).round() / 1_000_000.0
}
fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

pub fn build_report(result: &LayeringResult, cfg: &LayeringConfig) -> Value {
    let layer_count = result.layers.len();
    json!({
        "meta": {
            "generated_at": now_iso(),
            "algorithm_version": VERSION,
        },
        "config": cfg.to_json(),
        "summary": {
            "method": result.method,
            "layer_count": layer_count,
            "wire_assigned_count": result.assignment.len(),
            "plane_net_count": result.plane_nets.len(),
            "capacity_lower_bound": result.capacity_lower_bound,
            "iterations_used": result.iterations_used,
            "hard_conflict_count": result.hard_conflicts.len(),
            "soft_conflict_count": result.soft_conflicts.len(),
            "manual_route_net_count": result.manual_route_nets.len(),
            "manual_route_nets": result.manual_route_nets,
            "routable_net_count": result.routable_net_count,
            "total_net_count": result.total_net_count,
            "routable_ratio": if result.total_net_count > 0 {
                round4(result.routable_net_count as f64 / result.total_net_count as f64)
            } else {
                0.0
            },
            "unroutable_nets": result.unroutable_nets,
            "routable_path_net_count": result.routable_path_net_count,
            "routable_path_ratio": if result.total_net_count > 0 {
                round4(result.routable_path_net_count as f64 / result.total_net_count as f64)
            } else {
                0.0
            },
            "unroutable_nets_path": result.unroutable_nets_path,
            "multi_layer_nets": result.multi_layer_nets,
            "via_estimate": result.via_estimate,
            "warnings": result.warnings,
        },
        "plane_nets": result.plane_nets,
        "layers": result.layers.iter().map(|li| json!({
            "layer": li.layer_index,
            "kind": li.kind,
            "signal_groups": li.signal_groups,
            "nets": li.nets,
            "wires": li.wires,
            "soft_conflict_count": li.soft_conflict_count,
            "max_occupancy": li.max_occupancy,
            "requires_detour": li.requires_detour,
            "requires_endpoint_via": li.requires_endpoint_via,
        })).collect::<Vec<_>>(),
        "conflicts": {
            "hard": result.hard_conflicts.iter().map(conflict_to_json).collect::<Vec<_>>(),
            "soft": result.soft_conflicts.iter().map(conflict_to_json).collect::<Vec<_>>(),
        },
    })
}

pub fn write_report(report: &Value, out_dir: &str) -> Result<String, String> {
    let json_dir = format!("{}/json", out_dir.trim_end_matches(['/', '\\']));
    std::fs::create_dir_all(&json_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let path = format!("{json_dir}/report.json");
    let text = serde_json::to_string_pretty(report).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path)
}

pub fn export_layer_nets(result: &LayeringResult, out_dir: &str) -> Result<String, String> {
    let json_dir = format!("{}/json", out_dir.trim_end_matches(['/', '\\']));
    std::fs::create_dir_all(&json_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let path = format!("{json_dir}/layer_nets.json");
    let payload = json!({
        "units": "mm",
        "layers": result.layers.iter().map(|li| json!({
            "layer": li.layer_index,
            "kind": li.kind,
            "nets": li.nets,
        })).collect::<Vec<_>>(),
    });
    write_json(&path, &payload)?;
    Ok(path)
}

pub fn export_layer_nets_lst(result: &LayeringResult, out_dir: &str) -> Result<String, String> {
    let lst_dir = format!("{}/lst", out_dir.trim_end_matches(['/', '\\']));
    std::fs::create_dir_all(&lst_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let mut paths = Vec::new();
    for li in &result.layers {
        if li.kind != "signal" {
            continue;
        }
        let path = format!("{lst_dir}/layer_{}.lst", li.layer_index);
        let mut text = li.nets.join("\n");
        if !li.nets.is_empty() {
            text.push('\n');
        }
        std::fs::write(&path, text).map_err(|e| format!("写入失败: {e}"))?;
        paths.push(path);
    }
    Ok(paths.join(", "))
}

pub fn export_manual_route_lst(result: &LayeringResult, out_dir: &str) -> Result<String, String> {
    let lst_dir = format!("{}/lst", out_dir.trim_end_matches(['/', '\\']));
    std::fs::create_dir_all(&lst_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let path = format!("{lst_dir}/manual_route.lst");
    let mut text = result.manual_route_nets.join("\n");
    if !result.manual_route_nets.is_empty() {
        text.push('\n');
    }
    std::fs::write(&path, text).map_err(|e| format!("写入失败: {e}"))?;
    Ok(path)
}

pub fn export_net_layer_csv(result: &LayeringResult, out_dir: &str) -> Result<String, String> {
    let csv_dir = format!("{}/csv", out_dir.trim_end_matches(['/', '\\']));
    std::fs::create_dir_all(&csv_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let path = format!("{csv_dir}/net_layer_assignment.csv");
    let mut w = csv::Writer::from_path(&path).map_err(|e| format!("创建 CSV 失败: {e}"))?;
    w.write_record(["net_name", "layer"]).map_err(|e| e.to_string())?;
    for li in &result.layers {
        if li.kind != "signal" {
            continue;
        }
        for net in &li.nets {
            w.write_record([net, &li.layer_index.to_string()]).map_err(|e| e.to_string())?;
        }
    }
    w.flush().map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn export_layer_statistics_csv(result: &LayeringResult, out_dir: &str) -> Result<String, String> {
    let csv_dir = format!("{}/csv", out_dir.trim_end_matches(['/', '\\']));
    std::fs::create_dir_all(&csv_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let path = format!("{csv_dir}/layer_statistics.csv");
    let mut w = csv::Writer::from_path(&path).map_err(|e| format!("创建 CSV 失败: {e}"))?;
    w.write_record(["layer", "kind", "net_count", "wire_count", "soft_conflicts", "max_occupancy"])
        .map_err(|e| e.to_string())?;
    for li in &result.layers {
        w.write_record([
            &li.layer_index.to_string(),
            &li.kind,
            &li.nets.len().to_string(),
            &li.wires.len().to_string(),
            &li.soft_conflict_count.to_string(),
            &li.max_occupancy.to_string(),
        ])
        .map_err(|e| e.to_string())?;
    }
    w.flush().map_err(|e| e.to_string())?;
    Ok(path)
}

/// 打印摘要（与原 CLI 一致，供调试/日志）。
pub fn print_summary(result: &LayeringResult) -> String {
    let mut lines = vec![
        "== 探针卡飞线分层结果 ==".to_string(),
        format!(
            "方法 {} / 迭代 {} 轮 / 层数 {}",
            result.method,
            result.iterations_used,
            result.layers.len()
        ),
        format!(
            "已分配线 {} / 硬冲突 {} / 软冲突 {}",
            result.assignment.len(),
            result.hard_conflicts.len(),
            result.soft_conflicts.len()
        ),
        format!(
            "平面网: {}",
            if result.plane_nets.is_empty() {
                "(无)".to_string()
            } else {
                result.plane_nets.join(", ")
            }
        ),
    ];
    if !result.manual_route_nets.is_empty() {
        lines.push(format!(
            "需人工 route: {} 条（manual_route.lst）",
            result.manual_route_nets.len()
        ));
    }
    if result.total_net_count > 0 {
        lines.push(format!(
            "走通率 {}/{} 可布（{}%）",
            result.routable_net_count,
            result.total_net_count,
            (result.routable_net_count as f64 / result.total_net_count as f64 * 100.0).round()
        ));
        if result.total_net_count > 0 {
            lines.push(format!(
                "走通率(模拟路径) {}/{} 可布（{}%）",
                result.routable_path_net_count,
                result.total_net_count,
                (result.routable_path_net_count as f64 / result.total_net_count as f64 * 100.0).round()
            ));
        }
    }
    if result.multi_layer_nets > 0 {
        lines.push(format!(
            "跨层 net {} / 估算过孔 {}（少过孔度量，越小越好）",
            result.multi_layer_nets, result.via_estimate
        ));
    }
    if !result.capacity_lower_bound.is_empty() {
        let lb = result
            .capacity_lower_bound
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("容量下界（最少层数）: {lb}"));
    }
    for li in &result.layers {
        let mut extra = Vec::new();
        if li.soft_conflict_count > 0 {
            extra.push(format!("软冲突 {}", li.soft_conflict_count));
        }
        if li.max_occupancy > 0.0 {
            extra.push(format!("占用率 {:.2}", li.max_occupancy));
        }
        if !li.requires_detour.is_empty() {
            extra.push(format!("绕行 {}", li.requires_detour.join(",")));
        }
        if !li.requires_endpoint_via.is_empty() {
            extra.push(format!("端点过孔 {}", li.requires_endpoint_via.join(",")));
        }
        let suffix = if extra.is_empty() {
            String::new()
        } else {
            format!(" | {}", extra.join(" | "))
        };
        lines.push(format!(
            "  层 {} ({}): {} 线{}",
            li.layer_index,
            li.kind,
            li.wires.len(),
            suffix
        ));
    }
    if !result.warnings.is_empty() {
        lines.push("警告:".to_string());
        for w in &result.warnings {
            lines.push(format!("  - {w}"));
        }
    }
    lines.join("\n")
}

fn write_json(path: &str, v: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(v).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("写入失败: {e}"))
}
