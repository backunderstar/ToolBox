//! 飞线生成：2-pin 单线 / 3-pin share / ≥4-pin MST（移植自 Python `io/wire_gen.py`）。

use crate::model::{Net, NetClass, Pin, Wire};
use std::f64::INFINITY;

const _SHARE_SHORT_IGNORE: f64 = 10.0;

fn _wire(n: &Net, i: usize, a: &Pin, b: &Pin) -> Wire {
    Wire::new(
        format!("{n}_W{i}", n = n.net_id),
        n.net_id.clone(),
        a.pos,
        b.pos,
        n.width,
        n.clearance,
    )
}

/// 3-pin share：外 pin → 较远内 pin 长段 + 两内 pin 间短段。
pub fn share_wires(n: &Net, start_i: usize) -> Vec<Wire> {
    let outer = n
        .pins
        .iter()
        .max_by(|p, q| {
            (p.pos.x.hypot(p.pos.y)).partial_cmp(&(q.pos.x.hypot(q.pos.y))).unwrap()
        })
        .unwrap();
    let inners: Vec<&Pin> = n.pins.iter().filter(|p| p.pin_id != outer.pin_id).collect();
    let far = inners
        .iter()
        .max_by(|p, q| p.pos.dist(outer.pos).partial_cmp(&q.pos.dist(outer.pos)).unwrap())
        .unwrap();
    let other = if inners[0].pin_id != far.pin_id {
        inners[0]
    } else {
        inners[1]
    };
    let mut wires = vec![_wire(n, start_i, outer, far)];
    if far.pos.dist(other.pos) >= _SHARE_SHORT_IGNORE {
        wires.push(_wire(n, start_i + 1, far, other));
    }
    wires
}

/// 多 pin net（≥4）用 Prim 最小生成树连成飞线。
pub fn mst_wires(n: &Net, start_i: usize) -> Vec<Wire> {
    let pins = &n.pins;
    let npins = pins.len();
    let mut in_tree = vec![false; npins];
    let mut dist = vec![INFINITY; npins];
    let mut parent = vec![-1i64; npins];
    dist[0] = 0.0;
    let mut wires: Vec<Wire> = Vec::new();
    for _ in 0..npins {
        let mut u = None;
        let mut best = INFINITY;
        for i in 0..npins {
            if !in_tree[i] && dist[i] < best {
                best = dist[i];
                u = Some(i);
            }
        }
        let u = u.unwrap();
        in_tree[u] = true;
        if parent[u] != -1 {
            wires.push(_wire(n, start_i + wires.len(), &pins[parent[u] as usize], &pins[u]));
        }
        for v in 0..npins {
            if !in_tree[v] {
                let d = pins[u].pos.dist(pins[v].pos);
                if d < dist[v] {
                    dist[v] = d;
                    parent[v] = u as i64;
                }
            }
        }
    }
    wires
}

/// 无显式 wires 时生成飞线：2-pin 单线 / 3-pin share / ≥4-pin MST。
/// 只给 signal/power net 生成（电源走信号层一起分层）；ground 已在加载时剔除。
pub fn generate_wires(nets: &[Net], warnings: &mut Vec<String>) -> Vec<Wire> {
    let mut wires: Vec<Wire> = Vec::new();
    for n in nets {
        if !matches!(n.net_class, NetClass::Signal | NetClass::Power) {
            continue;
        }
        if n.pins.len() < 2 {
            warnings.push(format!("网络 {} 仅有 {} 个 pin，跳过", n.net_id, n.pins.len()));
            continue;
        }
        let i0 = wires.len();
        match n.pins.len() {
            2 => wires.push(_wire(n, i0, &n.pins[0], &n.pins[1])),
            3 => wires.extend(share_wires(n, i0)),
            _ => wires.extend(mst_wires(n, i0)),
        }
    }
    wires
}
