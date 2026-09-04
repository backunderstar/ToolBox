//! 分层质量指标：软冲突 + 数量/长短/扇区均衡（移植自 Python `core/metrics.py`）。

use crate::collections::HashMap;

/// 极角 [0,360) → 扇区号 [0, n)。n = round(360 / sector_angle_deg)。
pub fn sector_index(angle_deg: f64, sector_angle_deg: f64) -> i64 {
    let n = (360.0 / sector_angle_deg).round().max(1.0) as i64;
    let a = if angle_deg < 0.0 { angle_deg + 360.0 } else { angle_deg };
    (((a / sector_angle_deg) as i64) % n + n) % n
}

/// 同层软冲突（交叉）对数。只统计两端都已分配的线对。
pub fn soft_crossings(assignment: &HashMap<String, i64>, soft_pairs: &[(String, String)]) -> i64 {
    let mut total = 0;
    for (a, b) in soft_pairs {
        if let (Some(la), Some(lb)) = (assignment.get(a), assignment.get(b)) {
            if la == lb {
                total += 1;
            }
        }
    }
    total
}

/// 各层线数不均衡度 = (max - min) / mean，0 表示完全均衡。空层也算一层。
pub fn count_imbalance(layer_counts: &HashMap<i64, i64>) -> f64 {
    let vals: Vec<i64> = layer_counts.values().copied().collect();
    if vals.len() < 2 {
        return 0.0;
    }
    let sum: i64 = vals.iter().sum();
    let mean = sum as f64 / vals.len() as f64;
    if mean <= 0.0 {
        return 0.0;
    }
    let max = *vals.iter().max().unwrap() as f64;
    let min = *vals.iter().min().unwrap() as f64;
    (max - min) / mean
}

/// 各层平均线长不均衡度 = (max_avg - min_avg) / mean_avg。空层平均线长按 0 计。
pub fn length_imbalance(layer_lengths: &HashMap<i64, f64>, layer_counts: &HashMap<i64, i64>) -> f64 {
    let keys: Vec<&i64> = layer_counts.keys().collect();
    if keys.len() < 2 {
        return 0.0;
    }
    let avgs: Vec<f64> = keys
        .iter()
        .map(|l| {
            let c = *layer_counts.get(*l).unwrap_or(&0);
            if c > 0 {
                layer_lengths.get(*l).copied().unwrap_or(0.0) / c as f64
            } else {
                0.0
            }
        })
        .collect();
    let mean = avgs.iter().sum::<f64>() / avgs.len() as f64;
    if mean <= 0.0 {
        return 0.0;
    }
    let max = avgs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min = avgs.iter().cloned().fold(f64::INFINITY, f64::min);
    (max - min) / mean
}

/// 各层扇区覆盖不均衡度，只统计实际有线经过的扇区。
pub fn sector_imbalance(layer_sectors: &HashMap<i64, HashMap<i64, i64>>, total_wires: i64) -> f64 {
    let mut populated: crate::collections::HashSet<i64> = crate::collections::HashSet::default();
    for c in layer_sectors.values() {
        for k in c.keys() {
            populated.insert(*k);
        }
    }
    if populated.is_empty() || total_wires <= 0 {
        return 0.0;
    }
    let mut imbalance = 0.0;
    for s in populated {
        let mut maxv = 0i64;
        let mut minv = i64::MAX;
        for l in layer_sectors.keys() {
            let v = layer_sectors[l].get(&s).copied().unwrap_or(0);
            maxv = maxv.max(v);
            minv = minv.min(v);
        }
        if minv == i64::MAX {
            minv = 0;
        }
        imbalance += (maxv - minv) as f64;
    }
    imbalance / total_wires as f64
}
