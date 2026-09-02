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

/// 走通率基线：对每条已分配 net，在其**被分配层**内，若**所有** wires 的直线路径占用峰值
/// ≤ `layer_capacity`，则该 net 可布。返回 `(可布 net 数, 总 net 数, 不可布 net id 列表)`。
///
/// 说明：
/// - 每层占用/供应网格由**该层已分配 wires** 构建（与 `max_occupancy_per_layer` 同源），
///   因此"该 net 自身 + 同层其他 net"的密度都反映在占用里——这是"该层能否容得下这条 net 的廊道"的
///   **直线路径占用判定**。
/// - 这是**基线**版本；走通率随**模拟走线路径**（见"零过孔改进方案"里程碑 1）会更有区分度
///   （真实路径更长、要绕 keepout，比直线更容易顶到容量）。
pub fn routable_nets(
    assignment: &HashMap<String, i64>,
    wires: &[Wire],
    zones: &[crate::model::KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
) -> (usize, usize, Vec<String>) {
    let mut by_layer: HashMap<i64, Vec<Wire>> = HashMap::new();
    for w in wires {
        if let Some(&layer) = assignment.get(&w.wire_id) {
            by_layer.entry(layer).or_default().push(w.clone());
        }
    }
    let mut cmap_of: HashMap<i64, congestion::CongestionMap> = HashMap::new();
    for (layer, ws) in &by_layer {
        cmap_of.insert(*layer, congestion::build_congestion_map(ws, zones, pins, cfg));
    }

    let mut by_net: HashMap<String, Vec<&Wire>> = HashMap::new();
    for w in wires {
        if assignment.contains_key(&w.wire_id) {
            by_net.entry(w.net_id.clone()).or_default().push(w);
        }
    }

    let mut total = 0usize;
    let mut routable = 0usize;
    let mut unroutable: Vec<String> = Vec::new();
    for (net_id, ws) in by_net {
        total += 1;
        let ok = ws.iter().all(|w| {
            let Some(&layer) = assignment.get(&w.wire_id) else {
                return false;
            };
            match cmap_of.get(&layer) {
                Some(cmap) => congestion::occupancy_along(w, cmap) <= cfg.layer_capacity,
                None => true,
            }
        });
        if ok {
            routable += 1;
        } else {
            unroutable.push(net_id.clone());
        }
    }
    unroutable.sort();
    (routable, total, unroutable)
}
