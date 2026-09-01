//! DSATUR 着色（方法 A：对比基线，支持受限着色；移植自 Python `core/graph_coloring.py`）。

use crate::model::ConflictGraph;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct UncolorableError(pub String);

impl std::fmt::Display for UncolorableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for UncolorableError {}

/// DSATUR 变体。`allowed`（wire_id -> 允许层集合）None 表示任意层；`initial` 为预着色。
pub fn dsatur_color(
    graph: &ConflictGraph,
    max_layers: Option<i64>,
    allowed: Option<&HashMap<String, HashSet<i64>>>,
    initial: Option<&HashMap<String, i64>>,
) -> Result<HashMap<String, i64>, UncolorableError> {
    let mut colors: HashMap<String, i64> = initial.cloned().unwrap_or_default();
    let mut uncolored: Vec<String> = graph
        .nodes()
        .into_iter()
        .filter(|n| !colors.contains_key(n))
        .collect();

    while !uncolored.is_empty() {
        // 选饱和度最大、其次度数最大的未着色节点
        let mut best: Option<String> = None;
        let mut best_sat = -1;
        let mut best_deg = -1;
        for n in &uncolored {
            let mut seen: HashSet<i64> = HashSet::new();
            for m in graph.neighbors(n) {
                if let Some(&c) = colors.get(&m) {
                    seen.insert(c);
                }
            }
            let sat = seen.len() as i64;
            let deg = graph.neighbors(n).len() as i64;
            if sat > best_sat || (sat == best_sat && deg > best_deg) {
                best_sat = sat;
                best_deg = deg;
                best = Some(n.clone());
            }
        }
        let best_node = best.ok_or_else(|| UncolorableError("无节点可着色".into()))?;

        let mut used: HashSet<i64> = HashSet::new();
        for m in graph.neighbors(&best_node) {
            if let Some(&c) = colors.get(&m) {
                used.insert(c);
            }
        }
        let domain = allowed.and_then(|a| a.get(&best_node));
        let color: i64 = if let Some(domain) = domain {
            let mut avail: Vec<i64> = domain.iter().copied().filter(|c| !used.contains(c)).collect();
            avail.sort();
            if avail.is_empty() {
                let mut d: Vec<i64> = domain.iter().copied().collect();
                d.sort();
                let mut u: Vec<i64> = used.iter().copied().collect();
                u.sort();
                return Err(UncolorableError(format!(
                    "节点 {} 无可用层（允许 {:?}，邻用 {:?}）",
                    best_node, d, u
                )));
            }
            avail[0]
        } else {
            let mut c = 0;
            while used.contains(&c) {
                c += 1;
            }
            c
        };
        colors.insert(best_node.clone(), color);
        uncolored.retain(|n| n != &best_node);
    }

    if let Some(max_layers) = max_layers {
        let used_max = colors.values().copied().max().unwrap_or(0) + 1;
        if used_max > max_layers {
            return Err(UncolorableError(format!(
                "着色需要 {} 层，超过 max_layers={max_layers}",
                used_max
            )));
        }
    }
    Ok(colors)
}

pub fn minimize_layers(assignment: &HashMap<String, i64>) -> i64 {
    assignment.values().copied().max().map(|m| m + 1).unwrap_or(0)
}
