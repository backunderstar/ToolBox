//! 层叠 / 信号组工具：允许层、过孔可达性、plane 层过滤、按组归类
//! （移植自 Python `core/layer_stack.py`）。

use crate::config::LayeringConfig;
use crate::model::{LayerStack, Net, NetClass, SignalGroup, Wire};
use crate::collections::{HashMap, HashSet};

pub fn signal_layers(stack: Option<&LayerStack>) -> Vec<i64> {
    stack.map(|s| s.signal_layers()).unwrap_or_default()
}

pub fn plane_layers(stack: Option<&LayerStack>) -> Vec<i64> {
    stack.map(|s| s.plane_layers()).unwrap_or_default()
}

pub fn allowed_layers_of(group: &SignalGroup, stack: Option<&LayerStack>) -> Result<Vec<i64>, String> {
    if let Some(stack) = stack {
        let sig: HashSet<i64> = stack.signal_layers().into_iter().collect();
        for idx in &group.allowed_layers {
            if !sig.contains(idx) {
                return Err(format!(
                    "信号组 {} 的允许层 {} 不是 signal 层",
                    group.group_id, idx
                ));
            }
        }
    }
    Ok(group.allowed_layers.clone())
}

/// 通孔 → 全栈互连；盲埋微孔按 span（预留）。
pub fn can_hop(layer_a: i64, layer_b: i64, stack: Option<&LayerStack>) -> bool {
    match stack {
        Some(s) if s.via_kind != "through" => layer_a == layer_b,
        _ => true,
    }
}

/// 将走线 net 与 plane net（电源/地）分开。
pub fn split_trace_plane(nets: &[Net], cfg: &LayeringConfig) -> (Vec<Net>, Vec<Net>) {
    if !cfg.plane_nets_excluded {
        return (nets.to_vec(), Vec::new());
    }
    let mut trace = Vec::new();
    let mut plane = Vec::new();
    for n in nets {
        if matches!(n.net_class, NetClass::Power | NetClass::Ground) {
            plane.push(n.clone());
        } else {
            trace.push(n.clone());
        }
    }
    (trace, plane)
}

pub fn group_wires_by_signal_group(
    wires: &[Wire],
    nets: &[Net],
) -> HashMap<Option<String>, Vec<Wire>> {
    let mut net_to_group = HashMap::default();
    for n in nets {
        net_to_group.insert(n.net_id.clone(), n.signal_group_id.clone());
    }
    let mut groups: HashMap<Option<String>, Vec<Wire>> = HashMap::default();
    for w in wires {
        let g = net_to_group.get(&w.net_id).cloned().flatten();
        groups.entry(g).or_default().push(w.clone());
    }
    groups
}

/// 某 wire 的允许层集合（由其所属信号组决定）。
pub fn wire_allowed_layers(
    w: &Wire,
    nets: &[Net],
    groups: &[SignalGroup],
    stack: Option<&LayerStack>,
) -> HashSet<i64> {
    let net = nets.iter().find(|n| n.net_id == w.net_id);
    let gid = net.and_then(|n| n.signal_group_id.clone());
    if let Some(gid) = gid {
        for g in groups {
            if g.group_id == gid {
                let allowed = allowed_layers_of(g, stack).unwrap_or_default();
                return allowed.into_iter().collect();
            }
        }
    }
    signal_layers(stack).into_iter().collect()
}
