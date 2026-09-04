//! 禁布区加载、膨胀、线段相交、咽喉检测（移植自 Python `core/keepout.py`）。

use crate::config::LayeringConfig;
use crate::geometry;
use crate::model::{CircleZone, KeepoutZone, Point, RectZone, Wire};
use serde_json::Value;

pub fn load_keepouts(specs: &[Value]) -> Result<Vec<KeepoutZone>, String> {
    let mut zones = Vec::new();
    for s in specs {
        let shape = s.get("shape").and_then(|v| v.as_str()).unwrap_or("");
        if shape == "rect" {
            let z = RectZone {
                zone_id: s["zone_id"].as_str().unwrap_or("").to_string(),
                xmin: s["xmin"].as_f64().unwrap_or(0.0),
                ymin: s["ymin"].as_f64().unwrap_or(0.0),
                xmax: s["xmax"].as_f64().unwrap_or(0.0),
                ymax: s["ymax"].as_f64().unwrap_or(0.0),
            };
            zones.push(KeepoutZone::Rect(z));
        } else if shape == "circle" {
            let c = s.get("center").cloned().unwrap_or(Value::Null);
            let center = Point::new(
                c.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
                c.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
            );
            zones.push(KeepoutZone::Circle(CircleZone {
                zone_id: s["zone_id"].as_str().unwrap_or("").to_string(),
                center,
                radius: s["radius"].as_f64().unwrap_or(0.0),
            }));
        } else {
            return Err(format!("未知禁布区形状: {shape}"));
        }
    }
    Ok(zones)
}

pub fn zones_crossed_by(w: &Wire, zones: &[KeepoutZone], margin: f64) -> Vec<String> {
    let mut out = Vec::new();
    for z in zones {
        let crosses = match z {
            KeepoutZone::Rect(r) => {
                let m = if margin > 0.0 {
                    geometry::seg_in_rect_length(
                        w.start,
                        w.end,
                        &RectZone {
                            zone_id: r.zone_id.clone(),
                            xmin: r.xmin - margin,
                            ymin: r.ymin - margin,
                            xmax: r.xmax + margin,
                            ymax: r.ymax + margin,
                        },
                    )
                } else {
                    geometry::seg_in_rect_length(w.start, w.end, r)
                };
                m > geometry::EPS
            }
            KeepoutZone::Circle(c) => {
                let radius = c.radius + margin;
                geometry::seg_in_circle_length(
                    w.start,
                    w.end,
                    &CircleZone {
                        zone_id: c.zone_id.clone(),
                        center: c.center,
                        radius,
                    },
                ) > geometry::EPS
            }
        };
        if crosses {
            out.push(z.zone_id().to_string());
        }
    }
    out
}

pub fn both_cross_same_zone(wa: &Wire, wb: &Wire, zones: &[KeepoutZone]) -> Vec<String> {
    let a: crate::collections::HashSet<String> =
        zones_crossed_by(wa, zones, 0.0).into_iter().collect();
    let b: crate::collections::HashSet<String> =
        zones_crossed_by(wb, zones, 0.0).into_iter().collect();
    let mut out: Vec<String> = a.intersection(&b).cloned().collect();
    out.sort();
    out
}

pub fn in_zone_overlap_length(wa: &Wire, wb: &Wire, zone: &KeepoutZone) -> f64 {
    geometry::in_zone_overlap_length(wa, wb, zone)
}

/// 咽喉检测：多条线挤过同一禁布区且区窄（不足以并排通过）→ 咽喉。
pub fn pinch_zones(wires: &[Wire], zones: &[KeepoutZone], _cfg: &LayeringConfig) -> Vec<String> {
    let mut out = Vec::new();
    for z in zones {
        let crossing: Vec<&Wire> = wires
            .iter()
            .filter(|w| zones_crossed_by(w, std::slice::from_ref(z), 0.0).len() > 0)
            .collect();
        if crossing.len() < 2 {
            continue;
        }
        let narrow = match z {
            KeepoutZone::Rect(r) => (r.xmax - r.xmin).min(r.ymax - r.ymin),
            KeepoutZone::Circle(c) => 2.0 * c.radius,
        };
        let needed: f64 = crossing.iter().map(|w| w.width + w.clearance).sum();
        if narrow > 0.0 && needed / narrow > 1.0 {
            out.push(z.zone_id().to_string());
        }
    }
    out
}
