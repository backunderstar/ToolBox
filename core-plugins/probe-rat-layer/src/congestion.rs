//! 拥塞网格估计（移植自 Python `core/congestion.py`，用 ndarray 替代 numpy）。

use crate::config::LayeringConfig;
use crate::geometry;
use crate::model::{KeepoutZone, Pin, Wire};
use ndarray::Array2;
use crate::collections::HashSet;

#[derive(Debug)]
pub struct CongestionMap {
    pub cell: f64,
    pub origin: (f64, f64), // (xmin, ymin)
    pub width: usize,       // 列数
    pub height: usize,      // 行数
    pub demand: Array2<f64>,
    pub supply: Array2<f64>,
    pub occupancy: Array2<f64>,
}

pub(crate) fn _wire_cells(
    w: &Wire,
    origin: (f64, f64),
    cell: f64,
    rows: usize,
    cols: usize,
) -> HashSet<(usize, usize)> {
    let n = (w.length() / cell * 2.0) as usize + 1;
    let n = n.max(2);
    let mut cells: HashSet<(usize, usize)> = HashSet::default();
    for i in 0..n {
        let t = i as f64 / (n as f64 - 1.0);
        let x = w.start.x + (w.end.x - w.start.x) * t;
        let y = w.start.y + (w.end.y - w.start.y) * t;
        let c = ((x - origin.0) / cell).floor() as isize;
        let r = ((y - origin.1) / cell).floor() as isize;
        if r >= 0 && (r as usize) < rows && c >= 0 && (c as usize) < cols {
            cells.insert((r as usize, c as usize));
        }
    }
    cells
}

fn _rasterize(
    w: &Wire,
    origin: (f64, f64),
    cell: f64,
    rows: usize,
    cols: usize,
    demand: &mut Array2<f64>,
    value: f64,
) {
    for (r, c) in _wire_cells(w, origin, cell, rows, cols) {
        demand[[r, c]] += value;
    }
}

pub(crate) fn _grid_geometry(
    wires: &[Wire],
    zones: &[KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
) -> ((f64, f64), f64, usize, usize, Array2<f64>) {
    let cell = cfg.congestion_grid_cell.max(1e-6);
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    for w in wires {
        xs.push(w.start.x);
        xs.push(w.end.x);
        ys.push(w.start.y);
        ys.push(w.end.y);
    }
    for p in pins {
        xs.push(p.pos.x);
        ys.push(p.pos.y);
    }
    for z in zones {
        match z {
            KeepoutZone::Rect(r) => {
                xs.push(r.xmin);
                xs.push(r.xmax);
                ys.push(r.ymin);
                ys.push(r.ymax);
            }
            KeepoutZone::Circle(c) => {
                xs.push(c.center.x - c.radius);
                xs.push(c.center.x + c.radius);
                ys.push(c.center.y - c.radius);
                ys.push(c.center.y + c.radius);
            }
        }
    }
    if xs.is_empty() {
        return ((0.0, 0.0), cell, 1, 1, Array2::from_elem((1, 1), cell));
    }
    let xmin = xs.iter().cloned().fold(f64::INFINITY, f64::min) - cell;
    let xmax = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max) + cell;
    let ymin = ys.iter().cloned().fold(f64::INFINITY, f64::min) - cell;
    let ymax = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max) + cell;
    let cols = ((xmax - xmin) / cell).ceil() as usize + 1;
    let rows = ((ymax - ymin) / cell).ceil() as usize + 1;
    let origin = (xmin, ymin);

    let mut supply = Array2::from_elem((rows, cols), cell);

    // 网格中心坐标（用于禁布区扣除）
    let cxs: Vec<f64> = (0..cols).map(|i| xmin + (i as f64 + 0.5) * cell).collect();
    let rys: Vec<f64> = (0..rows).map(|i| ymin + (i as f64 + 0.5) * cell).collect();

    if cfg.keepout_enabled {
        for z in zones {
            for (r, &cy) in rys.iter().enumerate() {
                for (c, &cx) in cxs.iter().enumerate() {
                    if geometry::point_in_zone(point2(cx, cy), z) {
                        supply[[r, c]] = 0.0;
                    }
                }
            }
        }
    }
    if cfg.via_area_cost > 0.0 {
        for v in supply.iter_mut() {
            *v *= 1.0 - cfg.via_area_cost;
        }
    }
    if cfg.pin_density_weight > 1.0 {
        let discount = 1.0 / cfg.pin_density_weight;
        for p in pins {
            let c = ((p.pos.x - origin.0) / cell) as isize;
            let r = ((p.pos.y - origin.1) / cell) as isize;
            if r >= 0 && (r as usize) < rows && c >= 0 && (c as usize) < cols {
                supply[[r as usize, c as usize]] *= discount;
            }
        }
    }
    (origin, cell, cols, rows, supply)
}

fn point2(x: f64, y: f64) -> crate::model::Point {
    crate::model::Point::new(x, y)
}

/// 构建拥塞网格：`occupancy = demand / supply`（`> layer_capacity` 即超容）。
/// - `demand`：每条线用 `_wire_cells` 栅格化到格点，累加 `(线宽+线距) × congestion_demand_factor`。
/// - `supply`：基础为 `cell`，再扣**禁布区**(keepout→0)、**过孔预留**(×`1-via_area_cost`)、
///   **引脚密度**(pin 处 ×`1/pin_density_weight`)。
///
/// 被 `layer_routable`、`max_occupancy_per_layer`、`routable_nets*`、`congestion_balance` 共用——
/// 与"层占用峰值/走通率"是同一套语义，所以分层算法的 A/B 都用它作基准。
pub fn build_congestion_map(
    wires: &[Wire],
    zones: &[KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
) -> CongestionMap {
    let (origin, cell, cols, rows, supply) = _grid_geometry(wires, zones, pins, cfg);
    if wires.is_empty() && pins.is_empty() && zones.is_empty() {
        return CongestionMap {
            cell,
            origin,
            width: 1,
            height: 1,
            demand: Array2::zeros((1, 1)),
            supply,
            occupancy: Array2::zeros((1, 1)),
        };
    }
    let mut demand = Array2::zeros((rows, cols));
    for w in wires {
        _rasterize(
            w,
            origin,
            cell,
            rows,
            cols,
            &mut demand,
            (w.width + w.clearance) * cfg.congestion_demand_factor,
        );
    }
    let mut occupancy = Array2::zeros((rows, cols));
    for r in 0..rows {
        for c in 0..cols {
            let s = supply[[r, c]];
            if s > 1e-12 {
                occupancy[[r, c]] = demand[[r, c]] / s;
            }
        }
    }
    CongestionMap {
        cell,
        origin,
        width: cols,
        height: rows,
        demand,
        supply,
        occupancy,
    }
}

pub fn occupancy_at(x: f64, y: f64, cmap: &CongestionMap) -> f64 {
    let c = ((x - cmap.origin.0) / cmap.cell) as isize;
    let r = ((y - cmap.origin.1) / cmap.cell) as isize;
    if r >= 0 && (r as usize) < cmap.height && c >= 0 && (c as usize) < cmap.width {
        cmap.occupancy[[r as usize, c as usize]]
    } else {
        0.0
    }
}

pub fn occupancy_along(w: &Wire, cmap: &CongestionMap) -> f64 {
    let n = (w.length() / cmap.cell * 2.0) as usize + 1;
    let n = n.max(2);
    let mut max = 0.0;
    for i in 0..n {
        let t = i as f64 / (n as f64 - 1.0);
        let x = w.start.x + (w.end.x - w.start.x) * t;
        let y = w.start.y + (w.end.y - w.start.y) * t;
        let val = occupancy_at(x, y, cmap);
        if val > max {
            max = val;
        }
    }
    max
}

/// 折线路径上的占用峰值（里程碑 1：让走通率反映"真实路径"而非直线）。
pub fn occupancy_along_path(points: &[crate::model::Point], cmap: &CongestionMap) -> f64 {
    let mut max = 0.0;
    for seg in points.windows(2) {
        let (a, b) = (seg[0], seg[1]);
        let n = (a.dist(b) / cmap.cell * 2.0) as usize + 1;
        let n = n.max(2);
        for i in 0..n {
            let t = i as f64 / (n as f64 - 1.0);
            let x = a.x + (b.x - a.x) * t;
            let y = a.y + (b.y - a.y) * t;
            let val = occupancy_at(x, y, cmap);
            if val > max {
                max = val;
            }
        }
    }
    max
}

pub fn max_occupancy(cmap: &CongestionMap) -> f64 {
    cmap.occupancy.iter().cloned().fold(0.0, f64::max)
}

pub fn layer_routable(
    wires_subset: &[Wire],
    zones: &[KeepoutZone],
    pins: &[Pin],
    cfg: &LayeringConfig,
) -> (bool, CongestionMap, f64) {
    let cmap = build_congestion_map(wires_subset, zones, pins, cfg);
    let occ = max_occupancy(&cmap);
    (occ <= cfg.layer_capacity, cmap, occ)
}
