//! 后处理：校验、层标记、软冲突统计、层拥塞验证（移植自 Python `core/post_process.py`）。

use crate::config::LayeringConfig;
use crate::congestion;
use crate::keepout;
use crate::model::{Conflict, ConflictGraph, ConflictLevel, Pin, Wire};
use std::collections::HashMap;

pub fn verify_hard_free(
    assignment: &HashMap<String, i64>,
    graph: &ConflictGraph,
) -> Vec<(String, String)> {
    let mut viol = Vec::new();
    for (a, b) in graph.edges() {
        if let (Some(&la), Some(&lb)) = (assignment.get(&a), assignment.get(&b)) {
            if la == lb {
                viol.push((a, b));
            }
        }
    }
    viol
}

pub fn soft_conflicts_per_layer(
    assignment: &HashMap<String, i64>,
    conflicts: &[Conflict],
) -> HashMap<i64, i64> {
    let mut d: HashMap<i64, i64> = HashMap::new();
    for c in conflicts {
        if c.level == ConflictLevel::Soft {
            if let (Some(&la), Some(&lb)) = (assignment.get(&c.wire_a), assignment.get(&c.wire_b)) {
                if la == lb {
                    *d.entry(la).or_insert(0) += 1;
                }
            }
        }
    }
    d
}

/// 返回 (requires_detour, requires_endpoint_via)：层 -> wire_id 集合。
pub fn collect_layer_marks(
    wires: &[Wire],
    assignment: &HashMap<String, i64>,
    conflicts: &[Conflict],
    zones: &[crate::model::KeepoutZone],
    cfg: &LayeringConfig,
) -> (HashMap<i64, std::collections::HashSet<String>>, HashMap<i64, std::collections::HashSet<String>>) {
    let mut detour: HashMap<i64, std::collections::HashSet<String>> = HashMap::new();
    let mut via: HashMap<i64, std::collections::HashSet<String>> = HashMap::new();

    if cfg.keepout_enabled && !zones.is_empty() {
        for w in wires {
            if let Some(&layer) = assignment.get(&w.wire_id) {
                let margin = w.width / 2.0 + w.clearance + cfg.keepout_margin_factor * w.width;
                if !keepout::zones_crossed_by(w, zones, margin).is_empty() {
                    detour.entry(layer).or_default().insert(w.wire_id.clone());
                }
            }
        }
    }
    for c in conflicts {
        if c.level == ConflictLevel::Soft {
            if let Some(&la) = assignment.get(&c.wire_a) {
                let (d1, d2) = c.dist_to_endpoints;
                if d1 <= cfg.r_end || d2 <= cfg.r_end {
                    via.entry(la).or_default().insert(c.wire_a.clone());
                    via.entry(la).or_default().insert(c.wire_b.clone());
                }
            }
        }
    }
    (detour, via)
}

pub fn max_occupancy_per_layer(
    assignment: &HashMap<String, i64>,
    wires: &[Wire],
    zones: &[crate::model::KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
) -> HashMap<i64, f64> {
    let mut by_layer: HashMap<i64, Vec<Wire>> = HashMap::new();
    for w in wires {
        if let Some(&layer) = assignment.get(&w.wire_id) {
            by_layer.entry(layer).or_default().push(w.clone());
        }
    }
    let mut out = HashMap::new();
    for (layer, ws) in by_layer {
        let cmap = congestion::build_congestion_map(&ws, zones, pins, cfg);
        out.insert(layer, congestion::max_occupancy(&cmap));
    }
    out
}
