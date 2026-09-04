//! pipeline：loader → 分层 → 后处理 → 结果 的编排（移植自 Python `pipeline.py`）。

use crate::cancel::LayeringCancelled;
use crate::config::LayeringConfig;
use crate::layer_packing;
use crate::io::LoadedData;
use crate::model::{
    Conflict, ConflictLevel, KeepoutZone, LayerInfo, LayeringResult, Net, Pin, Wire,
};
use crate::optimizer;
use crate::state::Progress;
use crate::{
    conflict_classifier as cc, congestion, graph_coloring as coloring, layer_stack as lstack,
    metrics, post_process as pp,
};
use std::collections::{HashMap, HashSet};

fn _usable_area(wires: &[Wire], keepouts: &[KeepoutZone]) -> f64 {
    if wires.is_empty() {
        return 0.0;
    }
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    for w in wires {
        xs.push(w.start.x);
        xs.push(w.end.x);
        ys.push(w.start.y);
        ys.push(w.end.y);
    }
    let mut area = (xs.iter().cloned().fold(f64::INFINITY, f64::min)
        - xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
        .abs()
        * (ys.iter().cloned().fold(f64::INFINITY, f64::min)
            - ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
            .abs();
    for z in keepouts {
        match z {
            KeepoutZone::Rect(r) => area -= (r.xmax - r.xmin) * (r.ymax - r.ymin),
            KeepoutZone::Circle(c) => area -= std::f64::consts::PI * c.radius * c.radius,
        }
    }
    area.max(0.0)
}

/// 对未布通线累加 penalty（增量修复用）。返回新的 LoadedData。
pub fn apply_feedback_penalties(data: &LoadedData, unrouted: &HashSet<String>, amount: f64) -> LoadedData {
    let mut wires: Vec<Wire> = data
        .wires
        .iter()
        .map(|w| {
            let mut w = w.clone();
            if unrouted.contains(&w.wire_id) {
                w.penalty += amount;
            }
            w
        })
        .collect();
    wires.shrink_to_fit();
    let mut d = data.clone();
    d.wires = wires;
    d
}

fn net_id_str(n: &Net) -> &str {
    &n.net_id
}

/// 单轮分层。`prog.set(stage,pct,msg)` 报进度，`prog.check_cancel()` 取消。
pub fn run_once(
    data: &LoadedData,
    cfg: &LayeringConfig,
    prog: &Progress,
) -> Result<LayeringResult, LayeringCancelled> {
    prog.set("分离电源/地", 3.0, "分离电源/地");
    let (trace_nets, plane_nets) = lstack::split_trace_plane(&data.nets, cfg);
    let trace_net_ids: HashSet<String> =
        trace_nets.iter().map(|n| n.net_id.clone()).collect();
    let wires: Vec<Wire> = data
        .wires
        .iter()
        .filter(|w| trace_net_ids.contains(&w.net_id))
        .cloned()
        .collect();

    let group_of: HashMap<String, String> = trace_nets
        .iter()
        .map(|n| (n.net_id.clone(), n.signal_group_id.clone().unwrap_or_else(|| "default".to_string())))
        .collect();
    let wire_group_of: HashMap<String, String> = wires
        .iter()
        .map(|w| {
            (
                w.wire_id.clone(),
                group_of.get(&w.net_id).cloned().unwrap_or_else(|| "default".to_string()),
            )
        })
        .collect();
    let allowed: HashMap<String, HashSet<i64>> = wires
        .iter()
        .map(|w| {
            (
                w.wire_id.clone(),
                lstack::wire_allowed_layers(w, &trace_nets, &data.signal_groups, data.stack.as_ref()),
            )
        })
        .collect();
    let pins: Vec<Pin> = trace_nets.iter().flat_map(|n| n.pins.clone()).collect();
    prog.log_info(&format!(
        "[阶段 分离电源/地] trace={} plane={} wires={} 允许层规则={} 引脚={}",
        trace_nets.len(),
        plane_nets.len(),
        wires.len(),
        allowed.len(),
        pins.len()
    ));

    prog.check_cancel()?;
    prog.set("构建拥塞图", 12.0, "构建拥塞图");
    let cmap0 = congestion::build_congestion_map(&wires, &data.keepouts, &pins, cfg);
    prog.check_cancel()?;
    prog.set("冲突检测", 22.0, "冲突检测");
    let (conflicts, hard_graph) = cc::detect_all_conflicts(&wires, &data.keepouts, cfg, Some(&cmap0));
    prog.log_info(&format!(
        "[阶段 冲突检测] 候选线对={} 硬冲突={} 软冲突={}",
        conflicts.len(),
        conflicts.iter().filter(|c| c.level == ConflictLevel::Hard).count(),
        conflicts.iter().filter(|c| c.level == ConflictLevel::Soft).count(),
    ));
    prog.check_cancel()?;

    let usable = _usable_area(&wires, &data.keepouts);
    let lb = layer_packing::capacity_lower_bound(&wires, &wire_group_of, usable, cfg);
    let mut warnings: Vec<String> = data.warnings.clone();

    let mut assignment: HashMap<String, i64>;
    if cfg.method == "dsatur" {
        assignment = match coloring::dsatur_color(&hard_graph, None, Some(&allowed), None) {
            Ok(a) => a,
            Err(e) => {
                warnings.push(e.0);
                HashMap::new()
            }
        };
    } else {
        prog.set("扇区轮询分层", 32.0, "扇区轮询分层");
        let mut wrap = |f: f64| {
            prog.set("扇区轮询分层", 32.0 + f * 18.0, "扇区轮询分层");
        };
        assignment = layer_packing::pack_layers(
            &wires,
            &allowed,
            &data.keepouts,
            &pins,
            cfg,
            &hard_graph,
            data.stack.as_ref(),
            Some(&mut wrap),
            prog.cancel_flag(),
        )?;
        prog.log_info(&format!(
            "[阶段 扇区轮询分层] 已分配={}/{} 线",
            assignment.len(),
            wires.len()
        ));
        let soft_pairs: Vec<(String, String)> = conflicts
            .iter()
            .filter(|c| c.level == ConflictLevel::Soft)
            .map(|c| (c.wire_a.clone(), c.wire_b.clone()))
            .collect();
        let mut layers: Vec<i64> = assignment.values().copied().collect();
        layers.sort();
        layers.dedup();
        if cfg.optimizer != "none" {
            prog.set("贪心交叉最小化", 52.0, "贪心交叉最小化");
            assignment = layer_packing::minimize_crossings(
                &assignment,
                &soft_pairs,
                &layers,
                &hard_graph,
                cfg.minimize_crossings_passes,
                prog.cancel_flag(),
            )?;
            prog.log_info("[阶段 贪心交叉最小化] 完成");
            prog.check_cancel()?;
        }
        if cfg.optimizer == "sa" {
            let mut best = assignment;
            let mut best_soft = metrics::soft_crossings(&best, &soft_pairs);
            for r in 0..(cfg.sa_restarts.max(1)) {
                let mut c = cfg.clone();
                c.sa_seed = cfg.sa_seed + r as u64;
                let mut wrap = |f: f64| {
                    prog.set("模拟退火精修", 55.0 + f * 33.0, "模拟退火精修");
                };
                let cand = optimizer::optimize_layering(
                    &best,
                    &wires,
                    &soft_pairs,
                    &hard_graph,
                    &c,
                    &allowed,
                    Some(&mut wrap),
                    prog.cancel_flag(),
                )?;
                prog.check_cancel()?;
                let s = metrics::soft_crossings(&cand, &soft_pairs);
                if s < best_soft {
                    best = cand;
                    best_soft = s;
                }
            }
            assignment = best;
            prog.log_info(&format!("[阶段 模拟退火精修] 完成 best_soft={best_soft}"));
        }
    }

    // 后处理拥塞均衡（默认关）：把超容层/格点上的线平衡到低拥塞允许层，摊平层占用峰值
    if cfg.congestion_balance {
        prog.log_info("[阶段 后处理拥塞均衡] 开始");
        let soft_pairs: Vec<(String, String)> = conflicts
            .iter()
            .filter(|c| c.level == ConflictLevel::Soft)
            .map(|c| (c.wire_a.clone(), c.wire_b.clone()))
            .collect();
        pp::congestion_balance(
            &mut assignment,
            &wires,
            &data.keepouts,
            &pins,
            &hard_graph,
            &allowed,
            &soft_pairs,
            cfg,
            prog.cancel_flag(),
        )?;
    }

    prog.check_cancel()?;
    prog.set("后处理与人工兜底", 90.0, "后处理与人工兜底");
    let viol = pp::verify_hard_free(&assignment, &hard_graph);
    let mut manual_nets: Vec<String> = Vec::new();
    let mut manual_wires: HashSet<String> = HashSet::new();
    if !viol.is_empty() {
        for (a, b) in &viol {
            manual_wires.insert(a.clone());
            manual_wires.insert(b.clone());
        }
        let mut netset: HashSet<String> = wires
            .iter()
            .filter(|w| manual_wires.contains(&w.wire_id))
            .map(|w| w.net_id.clone())
            .collect();
        let mut mn: Vec<String> = netset.drain().collect();
        mn.sort();
        manual_nets = mn;
        for w in &manual_wires {
            assignment.remove(w);
        }
        warnings.push(format!(
            "{} 条线需人工 route（同层硬冲突无法自动分层）: {:?}",
            manual_nets.len(),
            manual_nets
        ));
    }
    prog.log_info(&format!(
        "[阶段 后处理与人工兜底] 需人工={} 线",
        manual_nets.len()
    ));

    let soft_per_layer = pp::soft_conflicts_per_layer(&assignment, &conflicts);
    let (detour, via) = pp::collect_layer_marks(&wires, &assignment, &conflicts, &data.keepouts, cfg);
    let occ_per_layer = pp::max_occupancy_per_layer(&assignment, &wires, &data.keepouts, &pins, cfg);
    let (routable_net_count, total_net_count, unroutable_nets) =
        pp::routable_nets(&assignment, &wires, &data.keepouts, &pins, cfg);
    let (multi_layer_nets, via_estimate) = pp::net_span_stats(&assignment, &wires);
    // 里程碑 1：走通率的"模拟路由路径"版（按层 preferred_dir 生成 L/Z 路径）
    let mut layer_dir: HashMap<i64, String> = HashMap::new();
    if let Some(s) = data.stack.as_ref() {
        for l in &s.layers {
            layer_dir.insert(l.index, l.preferred_dir.clone());
        }
    }
    let (routable_path_net_count, _, unroutable_nets_path) =
        pp::routable_nets_path(&assignment, &wires, &data.keepouts, &pins, cfg, &layer_dir);
    // 走通率（真实可布版）：层内"容量内可走"连通区洪泛——比直线/路径占用判定更诚实（可绕行）。
    let (routable_flood_net_count, _, unroutable_nets_flood) =
        pp::routable_nets_flood(&assignment, &wires, &data.keepouts, &pins, cfg);

    let net_by_id: HashMap<String, Net> = data
        .nets
        .iter()
        .map(|n| (n.net_id.clone(), n.clone()))
        .collect();

    let mut by_layer: HashMap<i64, Vec<Wire>> = HashMap::new();
    for w in &wires {
        if let Some(&l) = assignment.get(&w.wire_id) {
            by_layer.entry(l).or_default().push(w.clone());
        }
    }
    let mut layer_keys: Vec<i64> = by_layer.keys().copied().collect();
    layer_keys.sort();

    let mut layer_infos: Vec<LayerInfo> = Vec::new();
    for layer in layer_keys {
        let ws = &by_layer[&layer];
        let mut nets: Vec<String> = ws.iter().map(|w| w.net_id.clone()).collect();
        nets.sort();
        nets.dedup();
        let mut groups: Vec<String> = nets
            .iter()
            .filter_map(|n| net_by_id.get(n).and_then(|net| net.signal_group_id.clone()))
            .collect();
        groups.sort();
        groups.dedup();
        let mut wires_ids: Vec<String> = ws.iter().map(|w| w.wire_id.clone()).collect();
        wires_ids.sort();
        let mut detour_list: Vec<String> = detour
            .get(&layer)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        detour_list.sort();
        let mut via_list: Vec<String> = via
            .get(&layer)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        via_list.sort();
        layer_infos.push(LayerInfo {
            layer_index: layer,
            kind: data
                .stack
                .as_ref()
                .map(|s| s.kind_of(layer))
                .unwrap_or_else(|| "signal".to_string()),
            signal_groups: groups,
            wires: wires_ids,
            nets,
            soft_conflict_count: soft_per_layer.get(&layer).copied().unwrap_or(0),
            max_occupancy: round4(occ_per_layer.get(&layer).copied().unwrap_or(0.0)),
            requires_detour: detour_list,
            requires_endpoint_via: via_list,
        });
    }

    if !plane_nets.is_empty() && cfg.plane_nets_excluded && data.stack.is_some() {
        let mut plane_net_ids: Vec<String> = plane_nets.iter().map(net_id_str).map(str::to_string).collect();
        plane_net_ids.sort();
        for pl in data.stack.as_ref().unwrap().plane_layers() {
            layer_infos.push(LayerInfo {
                layer_index: pl,
                kind: "plane".to_string(),
                signal_groups: Vec::new(),
                wires: Vec::new(),
                nets: plane_net_ids.clone(),
                soft_conflict_count: 0,
                max_occupancy: 0.0,
                requires_detour: Vec::new(),
                requires_endpoint_via: Vec::new(),
            });
        }
    }
    layer_infos.sort_by_key(|li| li.layer_index);

    let unassigned: Vec<String> = wires
        .iter()
        .filter(|w| !assignment.contains_key(&w.wire_id) && !manual_wires.contains(&w.wire_id))
        .map(|w| w.wire_id.clone())
        .collect();
    if !unassigned.is_empty() {
        warnings.push(format!("以下线未能在允许层内分配: {:?}", unassigned));
    }

    let hard: Vec<Conflict> = conflicts
        .iter()
        .filter(|c| c.level == ConflictLevel::Hard)
        .cloned()
        .collect();
    let soft: Vec<Conflict> = conflicts
        .iter()
        .filter(|c| c.level == ConflictLevel::Soft)
        .cloned()
        .collect();
    let mut plane_nets_ids: Vec<String> = plane_nets.iter().map(net_id_str).map(str::to_string).collect();
    plane_nets_ids.sort();

    prog.set("完成", 100.0, "完成");
    Ok(LayeringResult {
        layers: layer_infos,
        assignment,
        plane_nets: plane_nets_ids,
        hard_conflicts: hard,
        soft_conflicts: soft,
        method: cfg.method.clone(),
        iterations_used: 1,
        capacity_lower_bound: lb,
        warnings,
        manual_route_nets: manual_nets,
        routable_net_count,
        total_net_count,
        unroutable_nets,
        routable_path_net_count,
        unroutable_nets_path,
        routable_flood_net_count,
        unroutable_nets_flood,
        multi_layer_nets,
        via_estimate,
    })
}

fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

/// 单轮分层；反馈闭环为占位（插件当前不传 feedback_path，等价单轮）。
pub fn run(
    data: &LoadedData,
    cfg: &LayeringConfig,
    feedback_path: Option<&str>,
    prog: &Progress,
) -> Result<LayeringResult, LayeringCancelled> {
    let _ = feedback_path;
    run_once(data, cfg, prog)
}
