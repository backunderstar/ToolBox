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

/// 里程碑 1：走通率的"模拟路由路径"版。每条已分配 wire 按其所在层 `preferred_dir` 生成曼哈顿 L/Z
/// 估计路径（带 margin 避开禁布区），判该路径占用峰值 ≤ `layer_capacity`。比直线版更贴近真实可布性
/// （真实路径更长、可能穿更多高密度区），通常给出**更低（更诚实）**的走通率。返回 `(可布, 总数, 不可布 id)`。
pub fn routable_nets_path(
    assignment: &HashMap<String, i64>,
    wires: &[Wire],
    zones: &[crate::model::KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
    layer_dir: &HashMap<i64, String>,
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
            let Some(cmap) = cmap_of.get(&layer) else {
                return true;
            };
            let preferred = layer_dir.get(&layer).map(|s| s.as_str()).unwrap_or("any");
            let margin = w.width / 2.0 + w.clearance + cfg.keepout_margin_factor * w.width;
            let route = crate::geometry::estimate_route(w.start, w.end, preferred, zones, margin);
            congestion::occupancy_along_path(&route, cmap) <= cfg.layer_capacity
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

/// 少过孔度量：`(跨层 net 数, via 估算数)`。
/// - 跨层 net 数 = 分布在 >1 层的 net 数（同 net 段分散到多层的网）。
/// - via 估算数 = Σ_nets (该 net 用到的层数 − 1)，≈需要新增过孔数的下界（仅已分配信号线）。
pub fn net_span_stats(
    assignment: &HashMap<String, i64>,
    wires: &[Wire],
) -> (usize, usize) {
    let mut net_layers: HashMap<String, std::collections::HashSet<i64>> = HashMap::new();
    for w in wires {
        if let Some(&layer) = assignment.get(&w.wire_id) {
            net_layers.entry(w.net_id.clone()).or_default().insert(layer);
        }
    }
    let mut multi = 0usize;
    let mut via = 0usize;
    for s in net_layers.values() {
        if s.len() > 1 {
            multi += 1;
        }
        via += s.len().saturating_sub(1);
    }
    (multi, via)
}

/// （走通率·真实可布版）对分层后的每一层，在"容量内可走"的栅格上做**连通分量洪泛**，判定
/// 每条 net 的所有线段端点是否落在同一连通可布区（层内存在贯穿的、容量内的通道）。
/// 比"直线/路径占用峰值 ≤ 层容量"更诚实：即使走直线超容，只要层内存在容量内的绕行通道
/// 也算可布。返回 `(可布 net 数, 已分配 net 总数, 不可布 net id)`。
pub fn routable_nets_flood(
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
    // 每层预计算：连通分量 + 栅格几何（供 net 端点映射到格）
    let mut layer_comp: HashMap<i64, ndarray::Array2<i32>> = HashMap::new();
    let mut layer_cmap: HashMap<i64, congestion::CongestionMap> = HashMap::new();
    for (layer, ws) in &by_layer {
        let cmap = congestion::build_congestion_map(ws, zones, pins, cfg);
        let comp = flood_components(&cmap, cfg.layer_capacity);
        layer_comp.insert(*layer, comp);
        layer_cmap.insert(*layer, cmap);
    }

    // 已分配 net 的 distinct id（一个 net 可能多段分布在多层；按 net 粒度去重）
    let mut net_ids: Vec<String> = Vec::new();
    {
        let mut seen = std::collections::HashSet::new();
        for w in wires {
            if assignment.contains_key(&w.wire_id) && seen.insert(w.net_id.clone()) {
                net_ids.push(w.net_id.clone());
            }
        }
    }
    net_ids.sort();

    let mut routable = 0usize;
    let mut unroutable: Vec<String> = Vec::new();
    for net_id in &net_ids {
        let mut ok = true;
        for w in wires.iter().filter(|w| &w.net_id == net_id && assignment.contains_key(&w.wire_id)) {
            let layer = assignment[&w.wire_id];
            let (Some(comp), Some(cmap)) = (layer_comp.get(&layer), layer_cmap.get(&layer)) else {
                ok = false;
                break;
            };
            let (Some(s), Some(e)) = (cell_of(w.start.x, w.start.y, cmap), cell_of(w.end.x, w.end.y, cmap))
            else {
                ok = false;
                break;
            };
            let cs = comp[[s.0, s.1]];
            let ce = comp[[e.0, e.1]];
            // 端点落在不可走格（keepout/超容）或分属不同连通块 → 不可布
            if cs == 0 || ce == 0 || cs != ce {
                ok = false;
                break;
            }
        }
        if ok {
            routable += 1;
        } else {
            unroutable.push(net_id.clone());
        }
    }
    unroutable.sort();
    (routable, net_ids.len(), unroutable)
}

/// 对一层栅格做连通分量标注：`comp[r][c] > 0` = 可走（容量内且非禁布区）的连通块编号；
/// `0` = 不可走（keepout / 占用超容）。4 邻接洪泛。
fn flood_components(cmap: &congestion::CongestionMap, layer_capacity: f64) -> ndarray::Array2<i32> {
    let (rows, cols) = cmap.occupancy.dim();
    let mut comp = ndarray::Array2::<i32>::zeros((rows, cols));
    let passable = |r: usize, c: usize| -> bool {
        cmap.supply[[r, c]] > 1e-12 && cmap.occupancy[[r, c]] <= layer_capacity
    };
    let mut next = 1i32;
    let mut stack: Vec<(usize, usize)> = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            if comp[[r, c]] != 0 || !passable(r, c) {
                continue;
            }
            comp[[r, c]] = next;
            stack.push((r, c));
            while let Some((r0, c0)) = stack.pop() {
                for (dr, dc) in [(0i32, 1i32), (0, -1), (1, 0), (-1, 0)] {
                    let nr = r0 as i32 + dr;
                    let nc = c0 as i32 + dc;
                    if nr < 0 || nc < 0 || nr >= rows as i32 || nc >= cols as i32 {
                        continue;
                    }
                    let (nr, nc) = (nr as usize, nc as usize);
                    if comp[[nr, nc]] == 0 && passable(nr, nc) {
                        comp[[nr, nc]] = next;
                        stack.push((nr, nc));
                    }
                }
            }
            next += 1;
        }
    }
    comp
}

/// 点 → 栅格 cell 下标（越界返回 None）。
fn cell_of(x: f64, y: f64, cmap: &congestion::CongestionMap) -> Option<(usize, usize)> {
    let c = ((x - cmap.origin.0) / cmap.cell).floor() as isize;
    let r = ((y - cmap.origin.1) / cmap.cell).floor() as isize;
    if r >= 0 && (r as usize) < cmap.height && c >= 0 && (c as usize) < cmap.width {
        Some((r as usize, c as usize))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::default_config;
    use crate::model::{KeepoutZone, Point, RectZone, Wire};

    /// 小 板（grid cell 10）：横向禁布带 y∈[40,60] 把板上下分开。
    /// net "cross"（y=50）端点落在禁布带内 → 不可布；net "below"（y=10）在下方连通区 → 可布。
    #[test]
    fn flood_rejects_net_crossing_keepout_band() {
        let mut cfg = default_config();
        cfg.congestion_grid_cell = 10.0;
        cfg.layer_capacity = 1.0;
        cfg.keepout_enabled = true;

        let zones = vec![KeepoutZone::Rect(RectZone {
            zone_id: "band".into(),
            xmin: 0.0,
            ymin: 40.0,
            xmax: 100.0,
            ymax: 60.0,
        })];

        let wires = vec![
            Wire::new("wc".into(), "cross".into(), Point::new(10.0, 50.0), Point::new(90.0, 50.0), 0.2, 0.2),
            Wire::new("wb".into(), "below".into(), Point::new(10.0, 10.0), Point::new(90.0, 10.0), 0.2, 0.2),
        ];
        let assignment: HashMap<String, i64> =
            [("wc".to_string(), 1i64), ("wb".to_string(), 1i64)].into_iter().collect();
        let (routable, total, unroutable) =
            routable_nets_flood(&assignment, &wires, &zones, &[], &cfg);
        assert_eq!(total, 2);
        assert_eq!(routable, 1, "只有 below 可布");
        assert_eq!(unroutable, vec!["cross".to_string()]);
    }
}

