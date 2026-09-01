//! Allegro 导出 → 内部模型（JSON 规范，双模式：wires 或 pins 生成）。
//! 移植自 Python `probe_layer/io/allegro_json.py`。

use crate::io::wire_gen::generate_wires;
use crate::io::LoadedData;
use crate::keepout;
use crate::model::{LayerDef, LayerStack, Net, NetClass, NetGroup, Pin, Point, SignalGroup, Units, Wire};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn _parse_nets(
    raw_nets: &Value,
    warnings: &mut Vec<String>,
) -> (Vec<Net>, HashMap<String, (f64, f64)>) {
    let mut nets: Vec<Net> = Vec::new();
    let mut meta: HashMap<String, (f64, f64)> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let arr = raw_nets.as_array().cloned().unwrap_or_default();
    for nd in &arr {
        let nid = nd.get("net_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if seen.contains(&nid) {
            warnings.push(format!("重复 net_id {nid}，已跳过"));
            continue;
        }
        seen.insert(nid.clone());
        let mut pins = Vec::new();
        if let Some(arr) = nd.get("pins").and_then(|v| v.as_array()) {
            for p in arr {
                pins.push(Pin {
                    pin_id: p.get("pin_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    pos: Point::new(
                        p.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                        p.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    ),
                });
            }
        }
        let width = nd.get("width").and_then(|v| v.as_f64()).unwrap_or(0.05);
        let clearance = nd.get("clearance").and_then(|v| v.as_f64()).unwrap_or(0.05);
        let nc = NetClass::parse(nd.get("net_class").and_then(|v| v.as_str()).unwrap_or("signal"));
        nets.push(Net {
            net_id: nid.clone(),
            net_class: nc,
            signal_group_id: nd.get("signal_group_id").and_then(|v| v.as_str()).map(str::to_string),
            net_group_id: nd.get("net_group_id").and_then(|v| v.as_str()).map(str::to_string),
            pins,
            width,
            clearance,
        });
        meta.insert(nid, (width, clearance));
    }
    (nets, meta)
}

pub fn load_allegro_json(path: &str) -> Result<LoadedData, String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("读取 JSON 失败: {e}"))?;
    let d: Value =
        serde_json::from_str(&content).map_err(|e| format!("解析 JSON 失败: {e}"))?;
    let mut warnings: Vec<String> = Vec::new();

    let units = Units::parse(d.get("units").and_then(|v| v.as_str()).unwrap_or("mm"));

    let mut stack: Option<LayerStack> = None;
    if let Some(ls) = d.get("layer_stack") {
        let mut layers = Vec::new();
        if let Some(arr) = ls.get("layers").and_then(|v| v.as_array()) {
            for l in arr {
                layers.push(LayerDef {
                    index: l.get("index").and_then(|v| v.as_i64()).unwrap_or(0),
                    name: l.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    kind: l.get("kind").and_then(|v| v.as_str()).unwrap_or("signal").to_string(),
                    preferred_dir: l
                        .get("preferred_dir")
                        .and_then(|v| v.as_str())
                        .unwrap_or("any")
                        .to_string(),
                });
            }
        }
        stack = Some(LayerStack {
            layers,
            via_kind: ls.get("via").and_then(|v| v.as_str()).unwrap_or("through").to_string(),
        });
    }

    let (nets, net_meta) = _parse_nets(&d.get("nets").cloned().unwrap_or(Value::Array(vec![])), &mut warnings);

    let groups: Vec<SignalGroup> = d
        .get("signal_groups")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|g| SignalGroup {
                    group_id: g.get("group_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    allowed_layers: g
                        .get("allowed_layers")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
                        .unwrap_or_default(),
                    net_ids: g
                        .get("net_ids")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    let ngroups: Vec<NetGroup> = d
        .get("net_groups")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|g| NetGroup {
                    group_id: g.get("group_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    kind: g.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    net_ids: g
                        .get("net_ids")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                    same_layer: g.get("same_layer").and_then(|v| v.as_bool()).unwrap_or(true),
                })
                .collect()
        })
        .unwrap_or_default();

    // 无 groups → 退化单组模式（所有 signal 层）
    let mut groups = groups;
    if groups.is_empty() && stack.is_some() {
        let sig_nets: Vec<String> = nets
            .iter()
            .filter(|n| n.net_class == NetClass::Signal)
            .map(|n| n.net_id.clone())
            .collect();
        groups = vec![SignalGroup {
            group_id: "default".to_string(),
            allowed_layers: stack.as_ref().unwrap().signal_layers(),
            net_ids: sig_nets,
        }];
    }

    // 无 stack → 从 groups 推断最小层叠
    let mut stack = stack;
    if stack.is_none() {
        let mut all_layers: Vec<i64> = groups.iter().flat_map(|g| g.allowed_layers.clone()).collect();
        all_layers.sort();
        all_layers.dedup();
        if all_layers.is_empty() {
            all_layers = vec![1];
        }
        stack = Some(LayerStack {
            layers: all_layers
                .into_iter()
                .map(|i| LayerDef {
                    index: i,
                    name: format!("L{i}"),
                    kind: "signal".to_string(),
                    preferred_dir: "any".to_string(),
                })
                .collect(),
            via_kind: "through".to_string(),
        });
    }

    let zones = keepout::load_keepouts(
        &d.get("keepouts")
            .map(|v| v.as_array().cloned().unwrap_or_default())
            .unwrap_or_default(),
    )?;

    let wires = if let Some(warr) = d.get("wires").and_then(|v| v.as_array()) {
        let mut wires: Vec<Wire> = Vec::new();
        let mut seen_w: HashSet<String> = HashSet::new();
        for w in warr.iter().filter(|w| w.get("wire_id").is_some()) {
            let wid = w["wire_id"].as_str().unwrap_or("").to_string();
            if seen_w.contains(&wid) {
                warnings.push(format!("重复 wire_id {wid}，已跳过"));
                continue;
            }
            seen_w.insert(wid.clone());
            let nid = w.get("net_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let (width, clearance) = net_meta.get(&nid).copied().unwrap_or((0.05, 0.05));
            let f = w.get("from").cloned().unwrap_or(Value::Null);
            let t = w.get("to").cloned().unwrap_or(Value::Null);
            let wire = Wire::new(
                wid,
                nid,
                Point::new(f.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0), f.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0)),
                Point::new(t.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0), t.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0)),
                width,
                clearance,
            );
            if wire.start.dist(wire.end) > 1e-9 {
                wires.push(wire);
            }
        }
        wires
    } else {
        generate_wires(&nets, &mut warnings)
    };

    Ok(LoadedData {
        stack,
        signal_groups: groups,
        net_groups: ngroups,
        nets,
        keepouts: zones,
        wires,
        units,
        warnings,
    })
}
