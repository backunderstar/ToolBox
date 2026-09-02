//! 直线冲突 + 禁布区 + 拥塞 → 硬/软/无 分级（移植自 Python `core/conflict_classifier.py`）。

use crate::config::LayeringConfig;
use crate::congestion::{occupancy_at, CongestionMap};
use crate::geometry;
use crate::keepout;
use crate::model::{Conflict, ConflictGraph, ConflictLevel, Wire};

/// bbox 相交的候选线对（同 net 排除），扫描线 O(n log n + k)。
/// 每个线 bbox 各向膨胀 `expansion_radius`（线宽/2+间距/2），使"引脚邻近"（端点对距离 < 0.5×(线宽+间距)）
/// 但**原始 bbox 不交**的线对也能进入候选——否则 pin 邻近硬冲突会被漏判（同层仍可出现过近 pin）。
pub fn pair_candidates(wires: &[Wire]) -> Vec<(usize, usize)> {
    let n = wires.len();
    if n < 2 {
        return Vec::new();
    }
    let xmin: Vec<f64> = wires
        .iter()
        .map(|w| w.bounding_box().0 - geometry::expansion_radius(w))
        .collect();
    let ymin: Vec<f64> = wires
        .iter()
        .map(|w| w.bounding_box().1 - geometry::expansion_radius(w))
        .collect();
    let xmax: Vec<f64> = wires
        .iter()
        .map(|w| w.bounding_box().2 + geometry::expansion_radius(w))
        .collect();
    let ymax: Vec<f64> = wires
        .iter()
        .map(|w| w.bounding_box().3 + geometry::expansion_radius(w))
        .collect();

    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&i, &j| xmin[i].partial_cmp(&xmin[j]).unwrap());
    let xs: Vec<f64> = order.iter().map(|&i| xmin[i]).collect();
    let xe: Vec<f64> = order.iter().map(|&i| xmax[i]).collect();
    let ys: Vec<f64> = order.iter().map(|&i| ymin[i]).collect();
    let ye: Vec<f64> = order.iter().map(|&i| ymax[i]).collect();
    let ns: Vec<&str> = order.iter().map(|&i| wires[i].net_id.as_str()).collect();

    let mut cands: Vec<(usize, usize)> = Vec::new();
    for a in 0..n {
        // j = 第一个 xs > xe[a] 的位置（xs 已排序）；b ∈ [a+1, j)
        let j = xs.partition_point(|&x| x <= xe[a] + geometry::EPS);
        let mut b = a + 1;
        while b < j {
            if ye[a] >= ys[b] + geometry::EPS
                && ye[b] >= ys[a] + geometry::EPS
                && ns[a] != ns[b]
            {
                cands.push((order[a], order[b]));
            }
            b += 1;
        }
    }
    cands
}

pub fn classify_pair(
    wa: &Wire,
    wb: &Wire,
    zones: &[crate::model::KeepoutZone],
    cfg: &LayeringConfig,
    cmap: Option<&CongestionMap>,
) -> Conflict {
    let inter = geometry::seg_seg_intersection(wa.start, wa.end, wb.start, wb.end);
    let (d, inter_pt) = match inter {
        Some(p) => (0.0, Some(p)),
        None => (
            geometry::seg_seg_min_distance(wa.start, wa.end, wb.start, wb.end),
            None,
        ),
    };
    let gap = geometry::clearance_gap(wa, wb, d);

    let (d1, d2) = match inter_pt {
        Some(p) => (
            p.dist(wa.start).min(p.dist(wa.end)),
            p.dist(wb.start).min(p.dist(wb.end)),
        ),
        None => (f64::INFINITY, f64::INFINITY),
    };
    let occ = if let Some(p) = inter_pt {
        cmap.map(|c| occupancy_at(p.x, p.y, c)).unwrap_or(0.0)
    } else {
        0.0
    };

    // 端点(引脚)邻近**硬**冲突：不同 net 任一端点(pin)对距离 < 0.5×(线宽+间距)（要求半径的一半）时，
    // 引脚附近的焊盘/走线会重叠，**不能放同一层**（严格要求不同 net 的 pin 不能靠太近）。
    // 半径随线宽缩放（width8 → 约 4.1mm；width0.2 → 约 0.2mm）。
    let req = 0.5 * geometry::min_allowed_distance(wa, wb);
    let mut ep = f64::INFINITY;
    for p in [wa.start, wa.end] {
        for q in [wb.start, wb.end] {
            let dd = p.dist(q);
            if dd < ep {
                ep = dd;
            }
        }
    }
    if ep < req {
        return Conflict {
            wire_a: wa.wire_id.clone(),
            wire_b: wb.wire_id.clone(),
            level: ConflictLevel::Hard,
            intersect_pt: inter_pt,
            clearance_gap: geometry::clearance_gap(wa, wb, ep),
            dist_to_endpoints: (d1, d2),
            keepout_ids: Vec::new(),
            congestion: occ,
            reasons: vec!["pin_proximity".to_string()],
        };
    }

    if gap <= geometry::EPS {
        // 无直线冲突
        if !cfg.keepout_enabled || zones.is_empty() {
            return Conflict {
                wire_a: wa.wire_id.clone(),
                wire_b: wb.wire_id.clone(),
                level: ConflictLevel::None,
                intersect_pt: inter_pt,
                clearance_gap: gap,
                dist_to_endpoints: (d1, d2),
                keepout_ids: Vec::new(),
                congestion: occ,
                reasons: vec!["no_conflict".to_string()],
            };
        }
        let shared = keepout::both_cross_same_zone(wa, wb, zones);
        if !shared.is_empty() {
            let two = [wa.clone(), wb.clone()];
            let pinch: std::collections::HashSet<String> =
                keepout::pinch_zones(&two, zones, cfg).into_iter().collect();
            let hard_zones: Vec<String> =
                shared.iter().filter(|z| pinch.contains(*z)).cloned().collect();
            if !hard_zones.is_empty() {
                let overlap = zones
                    .iter()
                    .filter(|z| hard_zones.contains(&z.zone_id().to_string()))
                    .any(|z| keepout::in_zone_overlap_length(wa, wb, z) > 0.0);
                if overlap {
                    return Conflict {
                        wire_a: wa.wire_id.clone(),
                        wire_b: wb.wire_id.clone(),
                        level: ConflictLevel::Hard,
                        intersect_pt: inter_pt,
                        clearance_gap: gap,
                        dist_to_endpoints: (d1, d2),
                        keepout_ids: hard_zones,
                        congestion: occ,
                        reasons: vec!["shared_keepout".to_string()],
                    };
                }
            }
            return Conflict {
                wire_a: wa.wire_id.clone(),
                wire_b: wb.wire_id.clone(),
                level: ConflictLevel::None,
                intersect_pt: inter_pt,
                clearance_gap: gap,
                dist_to_endpoints: (d1, d2),
                keepout_ids: shared,
                congestion: occ,
                reasons: vec!["single_keepout_detour".to_string()],
            };
        }
        return Conflict {
            wire_a: wa.wire_id.clone(),
            wire_b: wb.wire_id.clone(),
            level: ConflictLevel::None,
            intersect_pt: inter_pt,
            clearance_gap: gap,
            dist_to_endpoints: (d1, d2),
            keepout_ids: Vec::new(),
            congestion: occ,
            reasons: vec!["no_conflict".to_string()],
        };
    }

    // 存在直线冲突（间距不足）
    let shared = if cfg.keepout_enabled && !zones.is_empty() {
        keepout::both_cross_same_zone(wa, wb, zones)
    } else {
        Vec::new()
    };
    if !shared.is_empty() {
        let two = [wa.clone(), wb.clone()];
        let pinch: std::collections::HashSet<String> =
            keepout::pinch_zones(&two, zones, cfg).into_iter().collect();
        let hard_zones: Vec<String> =
            shared.iter().filter(|z| pinch.contains(*z)).cloned().collect();
        if !hard_zones.is_empty() {
            let overlap = zones
                .iter()
                .filter(|z| hard_zones.contains(&z.zone_id().to_string()))
                .any(|z| keepout::in_zone_overlap_length(wa, wb, z) > 0.0);
            if overlap {
                return Conflict {
                    wire_a: wa.wire_id.clone(),
                    wire_b: wb.wire_id.clone(),
                    level: ConflictLevel::Hard,
                    intersect_pt: inter_pt,
                    clearance_gap: gap,
                    dist_to_endpoints: (d1, d2),
                    keepout_ids: hard_zones,
                    congestion: occ,
                    reasons: vec!["shared_keepout".to_string()],
                };
            }
        }
    }
    if occ >= cfg.congestion_hard_threshold {
        return Conflict {
            wire_a: wa.wire_id.clone(),
            wire_b: wb.wire_id.clone(),
            level: ConflictLevel::Hard,
            intersect_pt: inter_pt,
            clearance_gap: gap,
            dist_to_endpoints: (d1, d2),
            keepout_ids: shared,
            congestion: occ,
            reasons: vec!["crossing_hotspot".to_string()],
        };
    }
    if d1 <= cfg.r_end || d2 <= cfg.r_end {
        return Conflict {
            wire_a: wa.wire_id.clone(),
            wire_b: wb.wire_id.clone(),
            level: ConflictLevel::Soft,
            intersect_pt: inter_pt,
            clearance_gap: gap,
            dist_to_endpoints: (d1, d2),
            keepout_ids: shared,
            congestion: occ,
            reasons: vec!["endpoint_tolerance".to_string()],
        };
    }
    Conflict {
        wire_a: wa.wire_id.clone(),
        wire_b: wb.wire_id.clone(),
        level: ConflictLevel::Soft,
        intersect_pt: inter_pt,
        clearance_gap: gap,
        dist_to_endpoints: (d1, d2),
        keepout_ids: shared,
        congestion: occ,
        reasons: vec!["crossing_low_congestion".to_string()],
    }
}

pub fn detect_all_conflicts(
    wires: &[Wire],
    zones: &[crate::model::KeepoutZone],
    cfg: &LayeringConfig,
    cmap: Option<&CongestionMap>,
) -> (Vec<Conflict>, ConflictGraph) {
    let mut conflicts: Vec<Conflict> = Vec::new();
    let mut graph = ConflictGraph::new();
    for w in wires {
        graph.add_node(&w.wire_id);
    }
    for (i, j) in pair_candidates(wires) {
        let c = classify_pair(&wires[i], &wires[j], zones, cfg, cmap);
        match c.level {
            ConflictLevel::Hard => {
                graph.add_edge(&c.wire_a, &c.wire_b);
                conflicts.push(c);
            }
            ConflictLevel::Soft => conflicts.push(c),
            ConflictLevel::None => {}
        }
    }
    (conflicts, graph)
}

pub fn build_hard_graph(conflicts: &[Conflict]) -> ConflictGraph {
    let mut graph = ConflictGraph::new();
    for c in conflicts {
        graph.add_node(&c.wire_a);
        graph.add_node(&c.wire_b);
        if c.level == ConflictLevel::Hard {
            graph.add_edge(&c.wire_a, &c.wire_b);
        }
    }
    graph
}
