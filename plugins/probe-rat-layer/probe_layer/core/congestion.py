"""拥塞网格估计（numpy + shapely.vectorized）。"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from shapely import contains_xy

from ..model import Wire, Pin, KeepoutZone
from ..config import LayeringConfig
from . import geometry as geo


@dataclass
class CongestionMap:
    cell: float
    origin: tuple[float, float]        # (xmin, ymin)
    width: int                         # 列数
    height: int                        # 行数
    demand: np.ndarray                 # 每格走线需求（穿越的线宽+间距 和，即占用节距，mm）
    supply: np.ndarray                 # 每格可布线宽度（横截面，mm）
    occupancy: np.ndarray              # demand / supply（满=1.0，量纲一致）


def _rasterize(w: Wire, origin, cell, rows, cols, demand: np.ndarray, value: float) -> None:
    n = max(2, int(w.length / cell * 2) + 1)
    t = np.linspace(0.0, 1.0, n)
    xs = w.start.x + (w.end.x - w.start.x) * t
    ys = w.start.y + (w.end.y - w.start.y) * t
    c = ((xs - origin[0]) / cell).astype(int)
    r = ((ys - origin[1]) / cell).astype(int)
    valid = (r >= 0) & (r < rows) & (c >= 0) & (c < cols)
    if not valid.any():
        return
    rc = np.unique(np.stack([r[valid], c[valid]], axis=1), axis=0)
    demand[rc[:, 0], rc[:, 1]] += value


def _grid_geometry(wires: tuple[Wire, ...], zones: tuple[KeepoutZone, ...],
                   pins: tuple[Pin, ...], cfg: LayeringConfig
                   ) -> tuple[tuple[float, float], float, int, int, np.ndarray]:
    """网格几何（origin/cell/cols/rows/supply），供全量 build 与增量维护共用。"""
    cell = max(cfg.congestion_grid_cell, 1e-6)

    xs: list[float] = []
    ys: list[float] = []
    for w in wires:
        xs += [w.start.x, w.end.x]
        ys += [w.start.y, w.end.y]
    for p in pins:
        xs.append(p.pos.x)
        ys.append(p.pos.y)
    for z in zones:
        if isinstance(z, geo.RectZone):
            xs += [z.xmin, z.xmax]
            ys += [z.ymin, z.ymax]
        else:
            xs += [z.center.x - z.radius, z.center.x + z.radius]
            ys += [z.center.y - z.radius, z.center.y + z.radius]

    if not xs:
        return (0.0, 0.0), cell, 1, 1, np.full((1, 1), cell)

    xmin, xmax = min(xs) - cell, max(xs) + cell
    ymin, ymax = min(ys) - cell, max(ys) + cell
    cols = int(np.ceil((xmax - xmin) / cell)) + 1
    rows = int(np.ceil((ymax - ymin) / cell)) + 1
    origin = (xmin, ymin)

    supply = np.full((rows, cols), cell)

    # 网格中心坐标（用于禁布区扣除）
    cxs = xmin + (np.arange(cols) + 0.5) * cell
    rys = ymin + (np.arange(rows) + 0.5) * cell
    xx, yy = np.meshgrid(cxs, rys)

    if cfg.keepout_enabled:
        for z in zones:
            mask = contains_xy(geo.zone_geom(z), xx.ravel(), yy.ravel()).reshape(rows, cols)
            supply[mask] = 0.0

    if cfg.via_area_cost > 0:
        supply *= (1.0 - cfg.via_area_cost)

    if cfg.pin_density_weight > 1.0:
        discount = 1.0 / cfg.pin_density_weight
        for p in pins:
            c = int((p.pos.x - origin[0]) / cell)
            r = int((p.pos.y - origin[1]) / cell)
            if 0 <= r < rows and 0 <= c < cols:
                supply[r, c] *= discount

    return origin, cell, cols, rows, supply


def build_congestion_map(wires: tuple[Wire, ...], zones: tuple[KeepoutZone, ...],
                         pins: tuple[Pin, ...], cfg: LayeringConfig) -> CongestionMap:
    origin, cell, cols, rows, supply = _grid_geometry(wires, zones, pins, cfg)
    if not wires and not pins and not zones:
        return CongestionMap(cell, origin, 1, 1,
                             np.zeros((1, 1)), supply, np.zeros((1, 1)))

    demand = np.zeros((rows, cols))
    for w in wires:
        _rasterize(w, origin, cell, rows, cols, demand,
                   (w.width + w.clearance) * cfg.congestion_demand_factor)

    # 被禁布区挡住的格子（supply≈0）不算拥塞：绕行由 requires_detour / 咽喉检测单独处理
    occupancy = np.zeros_like(demand)
    mask = supply > 1e-12
    occupancy[mask] = demand[mask] / supply[mask]
    return CongestionMap(cell, origin, cols, rows, demand, supply, occupancy)


def occupancy_at(x: float, y: float, cmap: CongestionMap) -> float:
    """某点所在格子的占用率（越界返回 0）。"""
    c = int((x - cmap.origin[0]) / cmap.cell)
    r = int((y - cmap.origin[1]) / cmap.cell)
    if 0 <= r < cmap.height and 0 <= c < cmap.width:
        return float(cmap.occupancy[r, c])
    return 0.0


def occupancy_along(w: Wire, cmap: CongestionMap) -> float:
    n = max(2, int(w.length / cmap.cell * 2) + 1)
    t = np.linspace(0.0, 1.0, n)
    xs = w.start.x + (w.end.x - w.start.x) * t
    ys = w.start.y + (w.end.y - w.start.y) * t
    c = ((xs - cmap.origin[0]) / cmap.cell).astype(int)
    r = ((ys - cmap.origin[1]) / cmap.cell).astype(int)
    valid = (r >= 0) & (r < cmap.height) & (c >= 0) & (c < cmap.width)
    if not valid.any():
        return 0.0
    return float(cmap.occupancy[r[valid], c[valid]].max())


def max_occupancy(cmap: CongestionMap) -> float:
    return float(cmap.occupancy.max())


def layer_routable(wires_subset: tuple[Wire, ...], zones: tuple[KeepoutZone, ...],
                   pins: tuple[Pin, ...], cfg: LayeringConfig
                   ) -> tuple[bool, CongestionMap, float]:
    cmap = build_congestion_map(wires_subset, zones, pins, cfg)
    occ = max_occupancy(cmap)
    return occ <= cfg.layer_capacity, cmap, occ
