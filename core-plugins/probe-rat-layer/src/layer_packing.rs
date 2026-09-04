//! 扇区轮询分层 + 均衡分配（方法 B：默认主算法）。
//! 移植自 Python `core/layer_packing.py`（含 numpy 栅格化 → ndarray）。

use crate::cancel::{check_cancel, CancelFlag, LayeringCancelled};
use crate::config::LayeringConfig;
use crate::model::{ConflictGraph, KeepoutZone, LayerStack, Pin, Wire};
use ndarray::Array2;
use crate::collections::{HashMap, HashSet};

/// 一条 wire 的扇区角度：靠外 pin 相对圆心 (0,0) 的极角 [0,360)。圆心定死 (0,0)。
pub fn wire_dir_angle(w: &Wire) -> f64 {
    let rs = w.start.x.hypot(w.start.y);
    let re = w.end.x.hypot(w.end.y);
    let (ox, oy) = if rs >= re { (w.start.x, w.start.y) } else { (w.end.x, w.end.y) };
    (oy.atan2(ox).to_degrees() % 360.0 + 360.0) % 360.0
}

#[derive(Debug, Clone)]
struct _Unit {
    uid: String,
    wires: Vec<Wire>,
    allowed: HashSet<i64>,
}

fn _units_conflict(a: &_Unit, b: &_Unit, graph: &ConflictGraph) -> bool {
    for wa in &a.wires {
        for wb in &b.wires {
            if graph.has_edge(&wa.wire_id, &wb.wire_id) {
                return true;
            }
        }
    }
    false
}

fn _make_units(
    wires: &[Wire],
    allowed: &HashMap<String, HashSet<i64>>,
    cfg: &LayeringConfig,
) -> Vec<_Unit> {
    // 只有"完全按段"（same_net_same_layer=false 且 软偏好 λ=0）才逐 wire 建 unit；
    // 一旦启用硬/软同 net（same_net_same_layer 或 same_net_via_penalty>0）都按 net 分组（整网优先）。
    if !cfg.same_net_same_layer && cfg.same_net_via_penalty <= 0.0 {
        return wires
            .iter()
            .map(|w| _Unit {
                uid: w.wire_id.clone(),
                wires: vec![w.clone()],
                allowed: allowed.get(&w.wire_id).cloned().unwrap_or_default(),
            })
            .collect();
    }
    let mut by_net: HashMap<String, Vec<Wire>> = HashMap::default();
    for w in wires {
        by_net.entry(w.net_id.clone()).or_default().push(w.clone());
    }
    let mut units = Vec::new();
    for (net_id, ws) in by_net {
        let mut allow: HashSet<i64> = HashSet::default();
        for w in &ws {
            if let Some(a) = allowed.get(&w.wire_id) {
                allow.extend(a.iter().copied());
            }
        }
        units.push(_Unit { uid: net_id.clone(), wires: ws, allowed: allow });
    }
    units
}

fn _dir_angle(u: &_Unit) -> f64 {
    wire_dir_angle(&u.wires[0])
}

fn _len(u: &_Unit) -> f64 {
    u.wires.iter().map(|w| w.length()).sum()
}

/// 单元 `u` 与目标层 `nl` 是否有硬冲突：若 `u` 的某根线的任一硬冲突邻接线落在层 `nl`
/// （且属于**另一个**单元），则冲突。基于邻接表，O(Σ deg(w))，替代 O(单元²×线²) 的两两扫描。
fn _unit_conflicts_layer(
    u: &_Unit,
    nl: i64,
    layer_wires: &HashMap<i64, HashSet<String>>,
    wire_loc: &HashMap<String, (i64, String)>,
    graph: &ConflictGraph,
) -> bool {
    let Some(ws) = layer_wires.get(&nl) else {
        return false;
    };
    if ws.is_empty() {
        return false;
    }
    for w in &u.wires {
        for nb in graph.neighbors(&w.wire_id) {
            if ws.contains(&nb) {
                if let Some((_, ub)) = wire_loc.get(&nb) {
                    if ub != &u.uid {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// 硬冲突消除（边驱动）：每轮从硬冲突图边构建"同层不同单元"的坏单元集合，再就近挪到无冲突允许层。
/// 相比逐轮两两扫描 `_units_conflict`，复杂度由 O(n²) 降到 O(边数 + 坏单元×邻接度)。
fn _resolve_conflicts(
    layer_units: &mut HashMap<i64, Vec<_Unit>>,
    layers: &[i64],
    graph: &ConflictGraph,
    rounds: i64,
    cancel: &CancelFlag,
) -> Result<(), LayeringCancelled> {
    if rounds <= 0 {
        return Ok(());
    }
    let edges = graph.edges();
    if edges.is_empty() {
        return Ok(());
    }
    for _ in 0..rounds {
        check_cancel(cancel)?;
        // wire -> (layer, unit_uid)；层 -> 该层所有 wire 集合。每轮重建（O(n)）。
        let mut wire_loc: HashMap<String, (i64, String)> = HashMap::default();
        let mut layer_wires: HashMap<i64, HashSet<String>> =
            layers.iter().map(|&l| (l, HashSet::default())).collect();
        for (l, us) in layer_units.iter() {
            for u in us {
                for w in &u.wires {
                    wire_loc.insert(w.wire_id.clone(), (*l, u.uid.clone()));
                    layer_wires.get_mut(l).unwrap().insert(w.wire_id.clone());
                }
            }
        }
        // 坏单元 = 同层且不同单元且存在硬冲突边（边驱动，替代两两扫描）
        let mut bad: HashSet<String> = HashSet::default();
        for (a, b) in &edges {
            if let (Some((la, ua)), Some((lb, ub))) = (wire_loc.get(a), wire_loc.get(b)) {
                if ua != ub && la == lb {
                    bad.insert(ua.clone());
                    bad.insert(ub.clone());
                }
            }
        }
        if bad.is_empty() {
            break;
        }
        let mut moved_any = false;
        for &l in layers {
            let snapshot = layer_units.get(&l).cloned().unwrap_or_default();
            if snapshot.is_empty() {
                continue;
            }
            let li = layers.iter().position(|x| *x == l).unwrap();
            for u in snapshot.iter().filter(|x| bad.contains(&x.uid)) {
                let mut cands: Vec<i64> = layers
                    .iter()
                    .copied()
                    .filter(|&nl| {
                        nl != l
                            && u.allowed.contains(&nl)
                            && !_unit_conflicts_layer(u, nl, &layer_wires, &wire_loc, graph)
                    })
                    .collect();
                if cands.is_empty() {
                    continue;
                }
                let li2 = li as i64;
                cands.sort_by_key(|&nl| {
                    let pos = layers.iter().position(|x| *x == nl).unwrap() as i64;
                    (pos - li2).abs()
                });
                let nl = cands[0];
                layer_units.get_mut(&l).unwrap().retain(|x| x.uid != u.uid);
                layer_units.get_mut(&nl).unwrap().push(u.clone());
                // 同步反向表，保证同轮后续判定看到的是移动后的状态
                for w in &u.wires {
                    wire_loc.insert(w.wire_id.clone(), (nl, u.uid.clone()));
                    layer_wires.get_mut(&l).unwrap().remove(&w.wire_id);
                    layer_wires.get_mut(&nl).unwrap().insert(w.wire_id.clone());
                }
                moved_any = true;
            }
        }
        if !moved_any {
            break;
        }
    }
    Ok(())
}

fn _balance_lengths(
    layer_units: &mut HashMap<i64, Vec<_Unit>>,
    layers: &[i64],
    graph: &ConflictGraph,
    rounds: i64,
    cancel: &CancelFlag,
) -> Result<(), LayeringCancelled> {
    for _ in 0..rounds {
        check_cancel(cancel)?;
        let mut changed = false;
        for li in 0..layers.len().saturating_sub(1) {
            let la = layers[li];
            let lb = layers[li + 1];
            let a = layer_units.get(&la).cloned().unwrap_or_default();
            let b = layer_units.get(&lb).cloned().unwrap_or_default();
            if a.is_empty() || b.is_empty() {
                continue;
            }
            let avga = a.iter().map(_len).sum::<f64>() / a.len() as f64;
            let avgb = b.iter().map(_len).sum::<f64>() / b.len() as f64;
            if (avga - avgb).abs() < 5.0 {
                continue;
            }
            let (src, dst) = if avga > avgb { (&a, &b) } else { (&b, &a) };
            if dst.len() < 2 {
                continue;
            }
            let long_u = src
                .iter()
                .max_by(|x, y| _len(x).partial_cmp(&_len(y)).unwrap())
                .unwrap();
            let short_u = dst
                .iter()
                .min_by(|x, y| _len(x).partial_cmp(&_len(y)).unwrap())
                .unwrap();
            if _len(long_u) <= _len(short_u) {
                continue;
            }
            if dst.iter().any(|x| x.uid != short_u.uid && _units_conflict(long_u, x, graph)) {
                continue;
            }
            if src.iter().any(|x| x.uid != long_u.uid && _units_conflict(short_u, x, graph)) {
                continue;
            }
            let (src_layer, dst_layer) = if avga > avgb { (la, lb) } else { (lb, la) };
            let long_u = long_u.clone();
            let short_u = short_u.clone();
            layer_units.get_mut(&src_layer).unwrap().retain(|x| x.uid != long_u.uid);
            layer_units.get_mut(&dst_layer).unwrap().push(long_u.clone());
            layer_units.get_mut(&dst_layer).unwrap().retain(|x| x.uid != short_u.uid);
            layer_units.get_mut(&src_layer).unwrap().push(short_u.clone());
            changed = true;
        }
        if !changed {
            break;
        }
    }
    Ok(())
}

fn _demand_value(w: &Wire, cfg: &LayeringConfig) -> f64 {
    (w.width + w.clearance) * cfg.congestion_demand_factor
}

fn _raster_into(
    w: &Wire,
    origin: (f64, f64),
    cell: f64,
    rows: usize,
    cols: usize,
    arr: &mut Array2<f64>,
    value: f64,
) {
    let n = ((w.length() / cell * 2.0) as usize + 1).max(2);
    let mut cells: HashSet<(usize, usize)> = HashSet::default();
    for i in 0..n {
        let t = if n > 1 { i as f64 / (n as f64 - 1.0) } else { 0.0 };
        let x = w.start.x + (w.end.x - w.start.x) * t;
        let y = w.start.y + (w.end.y - w.start.y) * t;
        let c = ((x - origin.0) / cell).floor() as isize;
        let r = ((y - origin.1) / cell).floor() as isize;
        if r >= 0 && (r as usize) < rows && c >= 0 && (c as usize) < cols {
            cells.insert((r as usize, c as usize));
        }
    }
    for (r, c) in cells {
        arr[[r, c]] += value;
    }
}

fn _max_occ(
    arr: &Array2<f64>,
    supply: &Array2<f64>,
    occupable: &Array2<bool>,
) -> f64 {
    let mut max = 0.0;
    for r in 0..arr.shape()[0] {
        for c in 0..arr.shape()[1] {
            if occupable[[r, c]] {
                let v = arr[[r, c]] / supply[[r, c]];
                if v > max {
                    max = v;
                }
            }
        }
    }
    max
}

/// 层 l 的拥塞平滑代价 `Σ_cells (occupancy)^k`（k 越大越惩罚高拥塞格点）。
fn _layer_cost(
    demand_of: &HashMap<i64, Array2<f64>>,
    l: i64,
    occupable: &Array2<bool>,
    supply: &Array2<f64>,
    k: f64,
) -> f64 {
    let d = &demand_of[&l];
    let mut s = 0.0;
    for r in 0..d.shape()[0] {
        for c in 0..d.shape()[1] {
            if occupable[[r, c]] {
                let o = d[[r, c]] / supply[[r, c]];
                s += o.powf(k);
            }
        }
    }
    s
}

/// 对层 l 应用 ucells（sign=+1 加入、-1 移出）后的代价增量。
fn _delta_cost_of(
    demand_of: &HashMap<i64, Array2<f64>>,
    l: i64,
    ucells: &HashMap<(usize, usize), f64>,
    occupable: &Array2<bool>,
    supply: &Array2<f64>,
    k: f64,
    sign: f64,
) -> f64 {
    let d = &demand_of[&l];
    let mut s = 0.0;
    for ((r, c), v) in ucells {
        if occupable[[*r, *c]] {
            let old = d[[*r, *c]] / supply[[*r, *c]];
            let new = (d[[*r, *c]] + sign * v) / supply[[*r, *c]];
            s += new.powf(k) - old.powf(k);
        }
    }
    s
}

/// 单元覆盖的栅格格点及在该格点上的需求增量（各线在该网点累加）。
/// 只算一次，供 `_enforce_capacity` 做增量的"目标层可行性判定 + 提交更新"，避免整栅格 clone/扫描。
fn _unit_cells(
    u: &_Unit,
    origin: (f64, f64),
    cell: f64,
    rows: usize,
    cols: usize,
    cfg: &LayeringConfig,
) -> HashMap<(usize, usize), f64> {
    let mut cells: HashMap<(usize, usize), f64> = HashMap::default();
    for w in &u.wires {
        let value = _demand_value(w, cfg);
        let n = ((w.length() / cell * 2.0) as usize + 1).max(2);
        let mut seen: HashSet<(usize, usize)> = HashSet::default();
        for i in 0..n {
            let t = if n > 1 { i as f64 / (n as f64 - 1.0) } else { 0.0 };
            let x = w.start.x + (w.end.x - w.start.x) * t;
            let y = w.start.y + (w.end.y - w.start.y) * t;
            let c = ((x - origin.0) / cell).floor() as isize;
            let r = ((y - origin.1) / cell).floor() as isize;
            if r >= 0 && (r as usize) < rows && c >= 0 && (c as usize) < cols {
                seen.insert((r as usize, c as usize));
            }
        }
        for pos in seen {
            *cells.entry(pos).or_insert(0.0) += value;
        }
    }
    cells
}

fn _enforce_capacity(
    layer_units: &mut HashMap<i64, Vec<_Unit>>,
    layers: &[i64],
    zones: &[KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
    graph: &ConflictGraph,
    cancel: &CancelFlag,
) -> Result<(), LayeringCancelled> {
    let all_wires: Vec<Wire> = layer_units
        .values()
        .flat_map(|us| us.iter().flat_map(|u| u.wires.clone()))
        .collect();
    if all_wires.is_empty() {
        return Ok(());
    }
    let (origin, cell, cols, rows, supply) =
        crate::congestion::_grid_geometry(&all_wires, zones, pins, cfg);
    let mut occupable = Array2::from_elem((rows, cols), false);
    for r in 0..rows {
        for c in 0..cols {
            occupable[[r, c]] = supply[[r, c]] > 1e-12;
        }
    }

    let mut layer_demand: HashMap<i64, Array2<f64>> = HashMap::default();
    let mut layer_max: HashMap<i64, f64> = HashMap::default();
    for &l in layers {
        let mut d = Array2::zeros((rows, cols));
        if let Some(us) = layer_units.get(&l) {
            for u in us {
                for w in &u.wires {
                    _raster_into(w, origin, cell, rows, cols, &mut d, _demand_value(w, cfg));
                }
            }
        }
        layer_max.insert(l, _max_occ(&d, &supply, &occupable));
        layer_demand.insert(l, d);
    }

    for &l in layers {
        check_cancel(cancel)?;
        if layer_max[&l] <= cfg.layer_capacity {
            continue;
        }
        let mut cur = layer_units.get(&l).cloned().unwrap_or_default();
        if cur.is_empty() {
            continue;
        }
        cur.sort_by(|a, b| _len(b).partial_cmp(&_len(a)).unwrap());
        for u in &cur {
            if layer_max[&l] <= cfg.layer_capacity {
                break;
            }
            // 该单元的需求格点（一次计算，供判定与提交复用）
            let ucells = _unit_cells(u, origin, cell, rows, cols, cfg);
            if ucells.is_empty() {
                continue;
            }
            for &nl in layers {
                if nl == l || !u.allowed.contains(&nl) {
                    continue;
                }
                if layer_units
                    .get(&nl)
                    .map(|x| x.iter().any(|y| _units_conflict(u, y, graph)))
                    .unwrap_or(false)
                {
                    continue;
                }
                // 目标层可行性：只在该单元的格点上计算新占用，取与现有全局最大值的较大者
                let mut new_max = layer_max[&nl];
                for ((r, c), val) in &ucells {
                    if occupable[[*r, *c]] {
                        let v = (layer_demand[&nl][[*r, *c]] + val) / supply[[*r, *c]];
                        if v > new_max {
                            new_max = v;
                        }
                    }
                }
                if new_max > cfg.layer_capacity {
                    continue;
                }
                // 提交移动（增量更新需求，不在整栅格 clone + 全扫）
                for ((r, c), val) in &ucells {
                    layer_demand.get_mut(&l).unwrap()[[*r, *c]] -= val;
                    layer_demand.get_mut(&nl).unwrap()[[*r, *c]] += val;
                }
                layer_units.get_mut(&l).unwrap().retain(|x| x.uid != u.uid);
                layer_units.get_mut(&nl).unwrap().push(u.clone());
                // 源层最大值需重算（被移除单元的格点可能正是峰值）；目标层用 new_max
                layer_max.insert(l, _max_occ(&layer_demand[&l], &supply, &occupable));
                layer_max.insert(nl, new_max);
                break;
            }
        }
    }
    Ok(())
}

/// 单元主导方向：按各线角度分类（[45,135) → V，否则 → H），多数胜出；空/平分 → "any"。
fn _unit_dir(u: &_Unit) -> &'static str {
    if u.wires.is_empty() {
        return "any";
    }
    let mut h = 0usize;
    let mut v = 0usize;
    for w in &u.wires {
        if (45.0..135.0).contains(&w.angle_deg()) {
            v += 1;
        } else {
            h += 1;
        }
    }
    if h == 0 && v == 0 {
        "any"
    } else if v > h {
        "V"
    } else {
        "H"
    }
}

/// 单元 `u` 放到层 `nl`（基于已有 layer_units 占用）是否会与**别的单元**产生硬冲突。
fn _unit_conflicts_layer_units(
    u: &_Unit,
    nl: i64,
    layer_units: &HashMap<i64, Vec<_Unit>>,
    graph: &ConflictGraph,
) -> bool {
    let Some(others) = layer_units.get(&nl) else {
        return false;
    };
    for w in &u.wires {
        for nb in graph.neighbors(&w.wire_id) {
            if others
                .iter()
                .any(|o| o.uid != u.uid && o.wires.iter().any(|w2| w2.wire_id == nb))
            {
                return true;
            }
        }
    }
    false
}

/// 贪心放置单个单元：在允许层中挑"方向匹配 + 当前负载最小"且**无硬冲突**的层；无则 None。
fn _place_unit(
    u: &_Unit,
    layer_units: &HashMap<i64, Vec<_Unit>>,
    layer_load: &HashMap<i64, f64>,
    layer_dir: &HashMap<i64, String>,
    layers: &[i64],
    graph: &ConflictGraph,
) -> Option<i64> {
    let mut cands: Vec<(i64, u8, f64)> = u
        .allowed
        .iter()
        .copied()
        .filter(|nl| layers.contains(nl))
        .filter(|nl| !_unit_conflicts_layer_units(u, *nl, layer_units, graph))
        .map(|nl| {
            let ldir = layer_dir.get(&nl).map(|s| s.as_str()).unwrap_or("any");
            let mismatch: u8 = match (_unit_dir(u), ldir) {
                ("H", "V") | ("V", "H") => 1,
                _ => 0,
            };
            let load = layer_load.get(&nl).copied().unwrap_or(0.0);
            (nl, mismatch, load)
        })
        .collect();
    if cands.is_empty() {
        return None;
    }
    cands.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.0.cmp(&b.0))
    });
    cands.first().map(|x| x.0)
}

/// 里程碑 0 的"两级决策"兜底：整网（net 单元）在冲突消除后仍与别网硬冲突（无法整体挪走）时，
/// 把它**按段拆成单线单元**再逐个贪心放（段级灵活兜底），从而既优先整网同层、又不拖垮受限网。
/// 只在 `same_net_via_penalty > 0`（软偏好）时启用；硬 `same_net_same_layer` 不拆。
fn _split_stuck_nets(
    layer_units: &mut HashMap<i64, Vec<_Unit>>,
    layers: &[i64],
    layer_dir: &HashMap<i64, String>,
    allowed: &HashMap<String, HashSet<i64>>,
    graph: &ConflictGraph,
    cancel: &CancelFlag,
) -> Result<(), LayeringCancelled> {
    check_cancel(cancel)?;
    // wire -> (layer, unit_uid)
    let mut wire_loc: HashMap<String, (i64, String)> = HashMap::default();
    for (l, us) in layer_units.iter() {
        for u in us {
            for w in &u.wires {
                wire_loc.insert(w.wire_id.clone(), (*l, u.uid.clone()));
            }
        }
    }
    // 顽固单元：与**别的单元**在同一层且存在硬冲突边（即冲突消除没挪走的整网）
    let mut stuck: HashSet<String> = HashSet::default();
    for (a, b) in graph.edges() {
        if let (Some((la, ua)), Some((lb, ub))) = (wire_loc.get(&a), wire_loc.get(&b)) {
            if la == lb && ua != ub {
                stuck.insert(ua.clone());
                stuck.insert(ub.clone());
            }
        }
    }
    if stuck.is_empty() {
        return Ok(());
    }
    let mut layer_load: HashMap<i64, f64> = layers
        .iter()
        .map(|&l| (l, layer_units.get(&l).map(|us| us.iter().map(_len).sum()).unwrap_or(0.0)))
        .collect();
    for &l in layers {
        check_cancel(cancel)?;
        let to_split: Vec<_Unit> = layer_units
            .get(&l)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|u| stuck.contains(&u.uid) && u.wires.len() > 1)
            .collect();
        for u in to_split {
            layer_units.get_mut(&l).unwrap().retain(|x| x.uid != u.uid);
            *layer_load.get_mut(&l).unwrap() -= _len(&u);
            // 按"难优先"（线长降序）拆成单线独立放置
            let mut wires = u.wires;
            wires.sort_by(|a, b| {
                b.length()
                    .partial_cmp(&a.length())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            for w in wires {
                check_cancel(cancel)?;
                let wu = _Unit {
                    uid: w.wire_id.clone(),
                    wires: vec![w.clone()],
                    allowed: allowed.get(&w.wire_id).cloned().unwrap_or_default(),
                };
                if let Some(nl) = _place_unit(&wu, layer_units, &layer_load, layer_dir, layers, graph) {
                    layer_units.get_mut(&nl).unwrap().push(wu.clone());
                    *layer_load.get_mut(&nl).unwrap() += _len(&wu);
                }
                // 无可用层：留给后续人工兜底（不进 assignment）
            }
        }
    }
    Ok(())
}

/// 里程碑 2：拥塞平滑代价 + 迭代整网 rip-up-and-reroute。
/// 对每层算拥塞平滑代价 `cost = Σ_cells (occupancy)^k`（k=congestion_k，软目标，避免阈值抖动），
/// 反复把"留在高拥塞层"的**整单元**搬到更匹配/更低拥塞且无硬冲突的层，使总代价下降；直到无改进
/// 或达到 `ripup_rounds`。整单元移动（不切层）→ 不引入过孔，与零过孔约束自洽。
/// 仅在 `cfg.ripup_rounds > 0` 时启用（默认 0=关闭，保留现有行为）。
fn _reroute_rounds(
    layer_units: &mut HashMap<i64, Vec<_Unit>>,
    layers: &[i64],
    zones: &[KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
    graph: &ConflictGraph,
    cancel: &CancelFlag,
) -> Result<(), LayeringCancelled> {
    let all_wires: Vec<Wire> = layer_units
        .values()
        .flat_map(|us| us.iter().flat_map(|u| u.wires.clone()))
        .collect();
    if all_wires.is_empty() {
        return Ok(());
    }
    let (origin, cell, cols, rows, supply) =
        crate::congestion::_grid_geometry(&all_wires, zones, pins, cfg);
    let mut occupable = Array2::from_elem((rows, cols), false);
    for r in 0..rows {
        for c in 0..cols {
            occupable[[r, c]] = supply[[r, c]] > 1e-12;
        }
    }
    let k = cfg.congestion_k.max(1.001);
    // 每层 demand 数组
    let mut demand_of: HashMap<i64, Array2<f64>> = HashMap::default();
    for &l in layers {
        let mut d = Array2::zeros((rows, cols));
        if let Some(us) = layer_units.get(&l) {
            for u in us {
                for w in &u.wires {
                    _raster_into(w, origin, cell, rows, cols, &mut d, _demand_value(w, cfg));
                }
            }
        }
        demand_of.insert(l, d);
    }
    for _ in 0..cfg.ripup_rounds.max(0) {
        check_cancel(cancel)?;
        let mut order: Vec<i64> = layers.to_vec();
        order.sort_by(|a, b| {
            _layer_cost(&demand_of, *b, &occupable, &supply, k)
                .partial_cmp(&_layer_cost(&demand_of, *a, &occupable, &supply, k))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut moved_any = false;
        'outer: for &l in &order {
            let units = layer_units.get(&l).cloned().unwrap_or_default();
            if units.is_empty() {
                continue;
            }
            let mut uorder: Vec<&_Unit> = units.iter().collect();
            uorder.sort_by(|a, b| _len(b).partial_cmp(&_len(a)).unwrap_or(std::cmp::Ordering::Equal));
            for u in uorder {
                let ucells = _unit_cells(u, origin, cell, rows, cols, cfg);
                if ucells.is_empty() {
                    continue;
                }
                let mut cands: Vec<i64> = layers
                    .iter()
                    .copied()
                    .filter(|&nl| nl != l && u.allowed.contains(&nl))
                    .filter(|&nl| !_unit_conflicts_layer_units(u, nl, layer_units, graph))
                    .collect();
                // 候选按"移动后方代价增量"从小到大
                cands.sort_by(|&a, &b| {
                    _delta_cost_of(&demand_of, a, &ucells, &occupable, &supply, k, 1.0)
                        .partial_cmp(&_delta_cost_of(&demand_of, b, &ucells, &occupable, &supply, k, 1.0))
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                for &nl in &cands {
                    let total_delta = _delta_cost_of(&demand_of, nl, &ucells, &occupable, &supply, k, 1.0)
                        + _delta_cost_of(&demand_of, l, &ucells, &occupable, &supply, k, -1.0);
                    if total_delta < -1e-9 {
                        for ((r, c), v) in &ucells {
                            demand_of.get_mut(&l).unwrap()[[*r, *c]] -= v;
                            demand_of.get_mut(&nl).unwrap()[[*r, *c]] += v;
                        }
                        layer_units.get_mut(&l).unwrap().retain(|x| x.uid != u.uid);
                        layer_units.get_mut(&nl).unwrap().push(u.clone());
                        moved_any = true;
                        break 'outer;
                    }
                }
            }
        }
        if !moved_any {
            break;
        }
    }
    Ok(())
}

fn _pack_units(
    units: Vec<_Unit>,
    layers: &[i64],
    layer_dir: &HashMap<i64, String>,
    zones: &[KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
    graph: &ConflictGraph,
    allowed: &HashMap<String, HashSet<i64>>,
    mut progress: Option<&mut dyn FnMut(f64)>,
    cancel: &CancelFlag,
) -> Result<HashMap<String, i64>, LayeringCancelled> {
    let mut prog = |f: f64| {
        if let Some(p) = progress.as_deref_mut() {
            p(f);
        }
    };
    prog(0.1);
    // 单元冲突度 = 相邻（有硬冲突边）的单元数，用于"最难优先"排序（借成熟网络排序思想）
    let mut wire_unit: HashMap<&str, &str> = HashMap::default();
    for u in &units {
        for w in &u.wires {
            wire_unit.insert(w.wire_id.as_str(), u.uid.as_str());
        }
    }
    let mut unit_deg: HashMap<&str, usize> =
        units.iter().map(|u| (u.uid.as_str(), 0usize)).collect();
    let mut pairs: HashSet<(String, String)> = HashSet::default();
    for (a, b) in graph.edges() {
        if let (Some(ua), Some(ub)) = (wire_unit.get(a.as_str()), wire_unit.get(b.as_str())) {
            if ua != ub {
                let key = if ua < ub {
                    (ua.to_string(), ub.to_string())
                } else {
                    (ub.to_string(), ua.to_string())
                };
                pairs.insert(key);
            }
        }
    }
    for (a, b) in &pairs {
        *unit_deg.get_mut(a.as_str()).unwrap() += 1;
        *unit_deg.get_mut(b.as_str()).unwrap() += 1;
    }
    // MFPS 排序：冲突度降序（最难/最受限优先），再按线长降序（较密优先）
    let mut order: Vec<&_Unit> = units.iter().collect();
    order.sort_by(|a, b| {
        let da = unit_deg.get(a.uid.as_str()).copied().unwrap_or(0);
        let db = unit_deg.get(b.uid.as_str()).copied().unwrap_or(0);
        db.cmp(&da)
            .then_with(|| _len(b).partial_cmp(&_len(a)).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.uid.cmp(&b.uid)) // 确定性
    });
    // 方向感知 + 负载均衡贪婪铺层：方向匹配优先（H→H 层、V→V 层），同级再选当前负载最小层
    let mut layer_units: HashMap<i64, Vec<_Unit>> =
        layers.iter().map(|&x| (x, Vec::new())).collect();
    let mut layer_load: HashMap<i64, f64> = layers.iter().map(|&l| (l, 0.0)).collect();
    for u in order {
        let udir = _unit_dir(u);
        let mut cands: Vec<(i64, u8, f64)> = u
            .allowed
            .iter()
            .copied()
            .map(|nl| {
                let ldir = layer_dir.get(&nl).map(|s| s.as_str()).unwrap_or("any");
                // 方向不匹配记高优先级惩罚；"any" 层/单元不惩罚
                let mismatch: u8 = match (udir, ldir) {
                    ("H", "V") | ("V", "H") => 1,
                    _ => 0,
                };
                let load = layer_load.get(&nl).copied().unwrap_or(0.0);
                (nl, mismatch, load)
            })
            .collect();
        cands.sort_by(|a, b| {
            a.1.cmp(&b.1)
                .then_with(|| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
                .then_with(|| a.0.cmp(&b.0)) // 确定性
        });
        let Some(best) = cands.first().map(|x| x.0) else {
            continue; // 无允许层：留给后续人工兜底
        };
        layer_units.get_mut(&best).unwrap().push(u.clone());
        *layer_load.get_mut(&best).unwrap() += _len(u);
    }
    prog(0.3);
    check_cancel(cancel)?;
    _resolve_conflicts(&mut layer_units, layers, graph, cfg.resolve_conflict_rounds, cancel)?;
    prog(0.5);
    check_cancel(cancel)?;
    _balance_lengths(&mut layer_units, layers, graph, cfg.balance_length_rounds, cancel)?;
    prog(0.7);
    check_cancel(cancel)?;
    _enforce_capacity(&mut layer_units, layers, zones, pins, cfg, graph, cancel)?;
    prog(0.9);
    check_cancel(cancel)?;
    // 里程碑 0：软同 net（λ>0）时，对"整网放不下/仍在硬冲突"的网做段级拆分兜底，再复跑容量校正。
    if cfg.same_net_via_penalty > 0.0 {
        _split_stuck_nets(&mut layer_units, layers, layer_dir, allowed, graph, cancel)?;
        prog(0.93);
        check_cancel(cancel)?;
        _enforce_capacity(&mut layer_units, layers, zones, pins, cfg, graph, cancel)?;
    }
    // 里程碑 2：拥塞平滑代价 + 迭代整网 reroute（默认关，ripup_rounds>0 启用）。
    if cfg.ripup_rounds > 0 {
        prog(0.95);
        check_cancel(cancel)?;
        _reroute_rounds(&mut layer_units, layers, zones, pins, cfg, graph, cancel)?;
    }
    let mut assignment: HashMap<String, i64> = HashMap::default();
    for (l, us) in &layer_units {
        for u in us {
            for w in &u.wires {
                assignment.insert(w.wire_id.clone(), *l);
            }
        }
    }
    prog(1.0);
    Ok(assignment)
}

pub fn pack_layers(
    wires: &[Wire],
    allowed: &HashMap<String, HashSet<i64>>,
    zones: &[KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
    graph: &ConflictGraph,
    stack: Option<&LayerStack>,
    progress: Option<&mut dyn FnMut(f64)>,
    cancel: &CancelFlag,
) -> Result<HashMap<String, i64>, LayeringCancelled> {
    let mut layer_set: HashSet<i64> = HashSet::default();
    for s in allowed.values() {
        for l in s {
            layer_set.insert(*l);
        }
    }
    let mut layers: Vec<i64> = layer_set.into_iter().collect();
    layers.sort();
    if layers.is_empty() {
        return Ok(HashMap::default());
    }
    // 逐层 preferred_dir（H/V/any），供方向感知铺层；无 stack 时默认 "any"
    let mut layer_dir: HashMap<i64, String> = HashMap::default();
    if let Some(s) = stack {
        for l in &s.layers {
            layer_dir.insert(l.index, l.preferred_dir.clone());
        }
    }
    let units = _make_units(wires, allowed, cfg);
    _pack_units(units, &layers, &layer_dir, zones, pins, cfg, graph, allowed, progress, cancel)
}

/// 同层软冲突（交叉）最小化：跨层线对交换，减少同层软冲突边数。
pub fn minimize_crossings(
    assignment: &HashMap<String, i64>,
    soft_pairs: &[(String, String)],
    layers: &[i64],
    graph: &ConflictGraph,
    max_passes: i64,
    cancel: &CancelFlag,
) -> Result<HashMap<String, i64>, LayeringCancelled> {
    let mut soft_adj: HashMap<String, HashSet<String>> = HashMap::default();
    for (a, b) in soft_pairs {
        soft_adj.entry(a.clone()).or_default().insert(b.clone());
        soft_adj.entry(b.clone()).or_default().insert(a.clone());
    }
    let mut layer_wires: HashMap<i64, HashSet<String>> = layers.iter().map(|&l| (l, HashSet::default())).collect();
    for (wid, l) in assignment {
        layer_wires.entry(*l).or_default().insert(wid.clone());
    }
    let mut assignment = assignment.clone();

    let soft_in = |wid: &str, l: i64, exclude: Option<&str>, layer_wires: &HashMap<i64, HashSet<String>>, soft_adj: &HashMap<String, HashSet<String>>| -> i64 {
        let mut count = 0;
        if let Some(ns) = soft_adj.get(wid) {
            for x in ns {
                if let Some(ws) = layer_wires.get(&l) {
                    if ws.contains(x) && exclude.map(|e| e != x).unwrap_or(true) {
                        count += 1;
                    }
                }
            }
        }
        count
    };
    let hard_in = |wid: &str, l: i64, layer_wires: &HashMap<i64, HashSet<String>>, graph: &ConflictGraph| -> bool {
        layer_wires
            .get(&l)
            .map(|ws| ws.iter().any(|x| graph.has_edge(wid, x) && x != wid))
            .unwrap_or(false)
    };

    for _ in 0..max_passes {
        check_cancel(cancel)?;
        let mut improved = false;
        for (a, b) in soft_pairs {
            let la = assignment.get(a).copied();
            let lb = assignment.get(b).copied();
            if la.is_none() || lb.is_none() || la == lb {
                continue;
            }
            let la = la.unwrap();
            let lb = lb.unwrap();
            if hard_in(a, lb, &layer_wires, graph) || hard_in(b, la, &layer_wires, graph) {
                continue;
            }
            let before = soft_in(a, la, Some(b), &layer_wires, &soft_adj)
                + soft_in(b, lb, Some(a), &layer_wires, &soft_adj);
            let after = soft_in(a, lb, Some(b), &layer_wires, &soft_adj)
                + soft_in(b, la, Some(a), &layer_wires, &soft_adj);
            if after < before {
                if let Some(ws) = layer_wires.get_mut(&la) {
                    ws.remove(a);
                }
                layer_wires.entry(lb).or_default().insert(a.clone());
                if let Some(ws) = layer_wires.get_mut(&lb) {
                    ws.remove(b);
                }
                layer_wires.entry(la).or_default().insert(b.clone());
                assignment.insert(a.clone(), lb);
                assignment.insert(b.clone(), la);
                improved = true;
            }
        }
        if !improved {
            break;
        }
    }
    Ok(assignment)
}

/// 每组容量下界：min_layers ≥ ceil(Σ(线长×节距) / (每层可用面积 × capacity_utilization))。
pub fn capacity_lower_bound(
    wires: &[Wire],
    group_of: &HashMap<String, String>,
    usable_area: f64,
    cfg: &LayeringConfig,
) -> HashMap<String, f64> {
    let mut total_area: HashMap<String, f64> = HashMap::default();
    for w in wires {
        let g = group_of
            .get(&w.wire_id)
            .cloned()
            .unwrap_or_else(|| "default".to_string());
        *total_area.entry(g).or_insert(0.0) += w.length() * (w.width + w.clearance);
    }
    let per_layer = usable_area * cfg.capacity_utilization;
    if per_layer <= 0.0 {
        return total_area.keys().map(|g| (g.clone(), 0.0)).collect();
    }
    total_area
        .into_iter()
        .map(|(g, a)| (g, (a / per_layer).ceil()))
        .collect()
}
