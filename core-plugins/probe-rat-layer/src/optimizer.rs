//! 模拟退火分层精修：以软冲突（交叉）为单一优化目标，均衡作为护栏。
//! 移植自 Python `core/optimizer.py`（RNG 用 rand_pcg，种子 cfg.sa_seed，结果自洽可复现；
//! 不追求与 Python random 逐位一致——分层质量的最终差异很小，见方案文档 §6.6）。

use crate::cancel::{check_cancel, CancelFlag, LayeringCancelled};
use crate::config::LayeringConfig;
use crate::layer_packing::wire_dir_angle;
use crate::metrics;
use crate::model::{ConflictGraph, Wire};
use rand::Rng;
use rand::SeedableRng;
use rand_pcg::Pcg64Mcg;
use crate::collections::{HashMap, HashSet};

fn _accept(cur_soft: i64, new_soft: i64, t: f64, rng: &mut Pcg64Mcg) -> bool {
    if new_soft <= cur_soft {
        return true;
    }
    if t <= 0.0 {
        return false;
    }
    rng.gen::<f64>() < ((-(new_soft - cur_soft) as f64) / t).exp()
}

fn inc(m: &mut HashMap<i64, HashMap<i64, i64>>, layer: i64, sector: i64) {
    *m.entry(layer).or_default().entry(sector).or_insert(0) += 1;
}
fn dec(m: &mut HashMap<i64, HashMap<i64, i64>>, layer: i64, sector: i64) {
    *m.entry(layer).or_default().entry(sector).or_insert(0) -= 1;
}

struct Sa<'a> {
    assignment: HashMap<String, i64>,
    layer_wires: HashMap<i64, HashSet<String>>,
    layer_len: HashMap<i64, f64>,
    layer_sector: HashMap<i64, HashMap<i64, i64>>,
    lc: HashMap<i64, i64>,
    soft_total: i64,
    soft_adj: HashMap<String, HashSet<String>>,
    layers: Vec<i64>,
    wire_by_id: HashMap<String, &'a Wire>,
    cfg: &'a LayeringConfig,
    graph: &'a ConflictGraph,
    base: (f64, f64, f64),
    slack: f64,
    rng: Pcg64Mcg,
    allowed: &'a HashMap<String, HashSet<i64>>,
}

impl<'a> Sa<'a> {
    fn sec(&self, w: &Wire) -> i64 {
        metrics::sector_index(wire_dir_angle(w), self.cfg.sector_angle_deg)
    }
    fn imbalances(&self) -> (f64, f64, f64) {
        let n: i64 = self.lc.values().sum();
        (
            metrics::count_imbalance(&self.lc),
            metrics::length_imbalance(&self.layer_len, &self.lc),
            metrics::sector_imbalance(&self.layer_sector, n),
        )
    }
    fn within_guardrail(&self) -> bool {
        let (c, ln, s) = self.imbalances();
        c <= (self.base.0.max(1e-6)) * self.slack
            && ln <= (self.base.1.max(1e-6)) * self.slack
            && s <= (self.base.2.max(1e-6)) * self.slack
    }
    fn hard_conflict_in(&self, wid: &str, l: i64, exclude: Option<&str>) -> bool {
        let Some(ws) = self.layer_wires.get(&l) else {
            return false;
        };
        if ws.is_empty() {
            return false;
        }
        // 只扫描 wid 的硬冲突邻接，避免每步遍历整层 wire 集合（O(deg) vs O(层线数)）
        for nb in self.graph.neighbors(wid) {
            if ws.contains(&nb) && exclude.map(|e| e != nb.as_str()).unwrap_or(true) {
                return true;
            }
        }
        false
    }
    fn soft_in(&self, wid: &str, l: i64, exclude: Option<&str>) -> i64 {
        let mut count = 0;
        if let Some(ns) = self.soft_adj.get(wid) {
            for x in ns {
                if let Some(ws) = self.layer_wires.get(&l) {
                    if ws.contains(x) && exclude.map(|e| e != x.as_str()).unwrap_or(true) {
                        count += 1;
                    }
                }
            }
        }
        count
    }
    fn try_swap(&mut self, a: &str, la: i64, b: &str, lb: i64, t: f64) -> bool {
        if self.hard_conflict_in(a, lb, Some(b)) || self.hard_conflict_in(b, la, Some(a)) {
            return false;
        }
        let d_soft = self.soft_in(a, lb, Some(b)) + self.soft_in(b, la, Some(a))
            - self.soft_in(a, la, None)
            - self.soft_in(b, lb, None);
        let wa = *self.wire_by_id.get(a).unwrap();
        let wb = *self.wire_by_id.get(b).unwrap();
        let sa = self.sec(wa);
        let sb = self.sec(wb);

        *self.layer_len.entry(la).or_insert(0.0) += wb.length() - wa.length();
        *self.layer_len.entry(lb).or_insert(0.0) += wa.length() - wb.length();
        dec(&mut self.layer_sector, la, sa);
        dec(&mut self.layer_sector, lb, sb);
        inc(&mut self.layer_sector, la, sb);
        inc(&mut self.layer_sector, lb, sa);

        if !self.within_guardrail() || !_accept(self.soft_total, self.soft_total + d_soft, t, &mut self.rng) {
            *self.layer_len.entry(la).or_insert(0.0) += wa.length() - wb.length();
            *self.layer_len.entry(lb).or_insert(0.0) += wb.length() - wa.length();
            inc(&mut self.layer_sector, la, sa);
            inc(&mut self.layer_sector, lb, sb);
            dec(&mut self.layer_sector, la, sb);
            dec(&mut self.layer_sector, lb, sa);
            return false;
        }
        self.layer_wires.get_mut(&la).unwrap().remove(a);
        self.layer_wires.entry(lb).or_default().insert(a.to_string());
        self.layer_wires.get_mut(&lb).unwrap().remove(b);
        self.layer_wires.entry(la).or_default().insert(b.to_string());
        self.assignment.insert(a.to_string(), lb);
        self.assignment.insert(b.to_string(), la);
        self.soft_total += d_soft;
        true
    }
    fn try_move(&mut self, w: &str, t: f64) -> bool {
        let Some(&la) = self.assignment.get(w) else {
            return false;
        };
        let allowed: Vec<i64> = self
            .allowed
            .get(w)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|l| *l != la)
            .collect();
        if allowed.is_empty() {
            return false;
        }
        let lb = allowed[self.rng.gen_range(0..allowed.len())];
        if self.hard_conflict_in(w, lb, None) {
            return false;
        }
        let d_soft = self.soft_in(w, lb, None) - self.soft_in(w, la, None);
        let ww = *self.wire_by_id.get(w).unwrap();
        let si = self.sec(ww);
        *self.layer_len.entry(la).or_insert(0.0) -= ww.length();
        *self.layer_len.entry(lb).or_insert(0.0) += ww.length();
        inc(&mut self.layer_sector, lb, si);
        dec(&mut self.layer_sector, la, si);
        *self.lc.entry(la).or_insert(0) -= 1;
        *self.lc.entry(lb).or_insert(0) += 1;

        if !self.within_guardrail() || !_accept(self.soft_total, self.soft_total + d_soft, t, &mut self.rng) {
            *self.layer_len.entry(la).or_insert(0.0) += ww.length();
            *self.layer_len.entry(lb).or_insert(0.0) -= ww.length();
            inc(&mut self.layer_sector, la, si);
            dec(&mut self.layer_sector, lb, si);
            *self.lc.entry(la).or_insert(0) += 1;
            *self.lc.entry(lb).or_insert(0) -= 1;
            return false;
        }
        self.layer_wires.get_mut(&la).unwrap().remove(w);
        self.layer_wires.entry(lb).or_default().insert(w.to_string());
        self.assignment.insert(w.to_string(), lb);
        self.soft_total += d_soft;
        true
    }
}

/// 模拟退火精修：在给定 assignment 上做局部搜索，返回（更优或等价的）分层。
///
/// **为什么用 SA**：层分配是离散组合优化，贪心初解容易停在局部最优；SA 用"接受更差解"来跳出。
/// - **代价**：`soft_crossings`（同层软交叉数）+ **层均衡护栏**（count/长度/扇区不均衡 ≤ `sa_balance_slack`，
///   `within_guardrail`）。注意：代价**不直接管拥塞**（拥塞由初始 `pack_layers` 定），所以 1.78 的圆心
///   占用峰值 SA 不主动压它（要靠 `congestion_balance`）。
/// - **邻域**：`try_swap`（交换两根线的层）+ `try_move`（挪一根线到别的允许层），移动前先查目标层
///   硬冲突（`hard_conflict_in`，O(deg) 邻接表），硬冲突则拒绝该移动。
/// - **接受**：`_accept`（metropolis）：更优必接受，更劣按 `exp(-Δ/t)` 概率接受；t 从 `sa_initial_temp`
///   按 `sa_cooling` 降温。
/// - **参数**：`sa_restarts`(多起点)、`sa_swap_ratio`(换 vs 挪 概率)、`sa_max_steps`(0=自动)。
///   ⚠️ `sa_max_steps` 调大反而更差（易陷入更差局部、需人工变多），勿拉满。
/// - 确定性：`rng` 用 `Pcg64Mcg::seed_from_u64(cfg.sa_seed)`，且容器用 `FxHashMap` → 同配置结果稳定。
pub fn optimize_layering(
    assignment: &HashMap<String, i64>,
    wires: &[Wire],
    soft_pairs: &[(String, String)],
    hard_graph: &ConflictGraph,
    cfg: &LayeringConfig,
    allowed: &HashMap<String, HashSet<i64>>,
    mut progress: Option<&mut dyn FnMut(f64)>,
    cancel: &CancelFlag,
) -> Result<HashMap<String, i64>, LayeringCancelled> {
    if assignment.is_empty() {
        return Ok(assignment.clone());
    }
    let mut layer_set: HashSet<i64> = HashSet::default();
    for s in allowed.values() {
        for l in s {
            layer_set.insert(*l);
        }
    }
    let mut layers: Vec<i64> = layer_set.into_iter().collect();
    layers.sort();
    if layers.len() < 2 {
        return Ok(assignment.clone());
    }

    let wire_by_id: HashMap<String, &Wire> = wires.iter().map(|w| (w.wire_id.clone(), w)).collect();
    let pairs: Vec<(String, String)> = soft_pairs
        .iter()
        .filter(|(a, b)| assignment.contains_key(a) && assignment.contains_key(b))
        .cloned()
        .collect();
    let mut soft_adj: HashMap<String, HashSet<String>> = HashMap::default();
    for (a, b) in &pairs {
        soft_adj.entry(a.clone()).or_default().insert(b.clone());
        soft_adj.entry(b.clone()).or_default().insert(a.clone());
    }

    let mut layer_wires: HashMap<i64, HashSet<String>> =
        layers.iter().map(|&l| (l, HashSet::default())).collect();
    let mut layer_len: HashMap<i64, f64> = layers.iter().map(|&l| (l, 0.0)).collect();
    let mut layer_sector: HashMap<i64, HashMap<i64, i64>> =
        layers.iter().map(|&l| (l, HashMap::default())).collect();
    for (wid, l) in assignment {
        layer_wires.entry(*l).or_default().insert(wid.clone());
        let w = wire_by_id[wid];
        *layer_len.entry(*l).or_insert(0.0) += w.length();
        let si = metrics::sector_index(wire_dir_angle(w), cfg.sector_angle_deg);
        *layer_sector.entry(*l).or_default().entry(si).or_insert(0) += 1;
    }
    let lc: HashMap<i64, i64> = layer_wires.iter().map(|(k, v)| (*k, v.len() as i64)).collect();
    let soft_total = metrics::soft_crossings(assignment, &pairs);

    let mut sa = Sa {
        assignment: assignment.clone(),
        layer_wires,
        layer_len,
        layer_sector,
        lc,
        soft_total,
        soft_adj,
        layers,
        wire_by_id,
        cfg,
        graph: hard_graph,
        base: (0.0, 0.0, 0.0),
        slack: cfg.sa_balance_slack,
        rng: Pcg64Mcg::seed_from_u64(cfg.sa_seed),
        allowed,
    };
    sa.base = sa.imbalances();

    let steps = if cfg.sa_max_steps > 0 {
        cfg.sa_max_steps as usize
    } else {
        (4000).max(30 * assignment.len())
    };
    let mut t = cfg.sa_initial_temp;
    let alpha = cfg.sa_cooling;
    let ids: Vec<String> = assignment.keys().cloned().collect();
    let progress_every = (steps / 50).max(1);
    let mut best_soft = sa.soft_total;
    let mut best_assignment = sa.assignment.clone();

    for i in 0..steps {
        if i % progress_every == 0 {
            if let Some(p) = progress.as_deref_mut() {
                p(i as f64 / steps as f64);
            }
            check_cancel(cancel)?;
        }
        let mut moved = false;
        if !pairs.is_empty() && sa.rng.gen_range(0.0..1.0) < cfg.sa_swap_ratio {
            let (a, b) = pairs[sa.rng.gen_range(0..pairs.len())].clone();
            let la = sa.assignment.get(&a).copied();
            let lb = sa.assignment.get(&b).copied();
            if la.is_some() && lb.is_some() && la != lb {
                moved = sa.try_swap(&a, la.unwrap(), &b, lb.unwrap(), t);
            }
        }
        if !moved {
            let w = ids[sa.rng.gen_range(0..ids.len())].clone();
            moved = sa.try_move(&w, t);
        }
        if moved && sa.soft_total < best_soft {
            best_soft = sa.soft_total;
            best_assignment = sa.assignment.clone();
        }
        t *= alpha;
        if t < 1e-12 {
            break;
        }
    }
    Ok(best_assignment)
}
