"""直线冲突 + 禁布区 + 拥塞 → 硬/软/无 分级。"""
from __future__ import annotations

import numpy as np

from ..model import Wire, KeepoutZone, Conflict, ConflictLevel, ConflictGraph, Point
from ..config import LayeringConfig
from . import geometry as geo
from . import keepout as ko
from .congestion import CongestionMap, occupancy_at


def classify_pair(wa: Wire, wb: Wire, zones: tuple[KeepoutZone, ...],
                  cfg: LayeringConfig, cmap: CongestionMap | None = None) -> Conflict:
    la = geo.line_of(wa.start, wa.end)
    lb = geo.line_of(wb.start, wb.end)
    inter = la.intersection(lb)
    if inter.is_empty:
        d = la.distance(lb)
        inter_pt: Point | None = None
    else:
        d = 0.0
        inter_pt = Point(inter.x, inter.y) if inter.geom_type == "Point" else None

    gap = geo.clearance_gap(wa, wb, d)

    d1 = d2 = float("inf")
    if inter_pt is not None:
        d1 = min(inter_pt.dist(wa.start), inter_pt.dist(wa.end))
        d2 = min(inter_pt.dist(wb.start), inter_pt.dist(wb.end))

    # 交点处的拥塞（精确到格子）；无交点（平行近距）不判拥塞热点
    occ = occupancy_at(inter_pt.x, inter_pt.y, cmap) if (inter_pt is not None and cmap is not None) else 0.0

    reasons: list[str] = []

    if gap <= geo.EPS:
        # 无直线冲突
        if not cfg.keepout_enabled or not zones:
            return Conflict(wa.wire_id, wb.wire_id, ConflictLevel.NONE,
                            inter_pt, gap, (d1, d2), (), occ, ("no_conflict",))
        shared = ko.both_cross_same_zone(wa, wb, zones)
        if shared:
            pinch = set(ko.pinch_zones((wa, wb), zones, cfg))
            hard_zones = [z for z in shared if z in pinch]
            if hard_zones and any(ko.in_zone_overlap_length(wa, wb, z) > 0
                                  for z in zones if z.zone_id in hard_zones):
                return Conflict(wa.wire_id, wb.wire_id, ConflictLevel.HARD,
                                inter_pt, gap, (d1, d2), tuple(hard_zones), occ,
                                ("shared_keepout",))
            return Conflict(wa.wire_id, wb.wire_id, ConflictLevel.NONE,
                            inter_pt, gap, (d1, d2), tuple(shared), occ,
                            ("single_keepout_detour",))
        return Conflict(wa.wire_id, wb.wire_id, ConflictLevel.NONE,
                        inter_pt, gap, (d1, d2), (), occ, ("no_conflict",))

    # 存在直线冲突（间距不足）
    shared = ko.both_cross_same_zone(wa, wb, zones) if (cfg.keepout_enabled and zones) else ()

    # 优先级 #4 禁布区咽喉 > #2 拥塞热点 > #3 低拥塞 > #6 端点容忍
    if shared:
        pinch = set(ko.pinch_zones((wa, wb), zones, cfg))
        hard_zones = [z for z in shared if z in pinch]
        if hard_zones and any(ko.in_zone_overlap_length(wa, wb, z) > 0
                              for z in zones if z.zone_id in hard_zones):
            return Conflict(wa.wire_id, wb.wire_id, ConflictLevel.HARD,
                            inter_pt, gap, (d1, d2), tuple(hard_zones), occ,
                            ("shared_keepout",))

    if occ >= cfg.congestion_hard_threshold:
        return Conflict(wa.wire_id, wb.wire_id, ConflictLevel.HARD,
                        inter_pt, gap, (d1, d2), tuple(shared), occ,
                        ("crossing_hotspot",))

    if d1 <= cfg.r_end or d2 <= cfg.r_end:
        return Conflict(wa.wire_id, wb.wire_id, ConflictLevel.SOFT,
                        inter_pt, gap, (d1, d2), tuple(shared), occ,
                        ("endpoint_tolerance",))

    return Conflict(wa.wire_id, wb.wire_id, ConflictLevel.SOFT,
                    inter_pt, gap, (d1, d2), tuple(shared), occ,
                    ("crossing_low_congestion",))


def pair_candidates(wires: tuple[Wire, ...]) -> list[tuple[int, int]]:
    """bbox 相交的候选线对（同 net 排除），扫描线 + numpy 向量化，O(n log n + k)。"""
    n = len(wires)
    if n < 2:
        return []
    xmin = np.array([w.bounding_box[0] for w in wires])
    ymin = np.array([w.bounding_box[1] for w in wires])
    xmax = np.array([w.bounding_box[2] for w in wires])
    ymax = np.array([w.bounding_box[3] for w in wires])
    nets = np.array([w.net_id for w in wires], dtype=object)

    order = np.argsort(xmin, kind="stable")
    xs = xmin[order]
    xe = xmax[order]
    ys = ymin[order]
    ye = ymax[order]
    ns = nets[order]

    cands: list[tuple[int, int]] = []
    for a in range(n):
        j = int(np.searchsorted(xs, xe[a], side="right"))
        b = np.arange(a + 1, j)
        if b.size == 0:
            continue
        m = (ye[a] >= ys[b]) & (ye[b] >= ys[a]) & (ns[a] != ns[b])
        sel = b[m]
        if sel.size == 0:
            continue
        ia = int(order[a])
        for jj in order[sel]:
            cands.append((ia, int(jj)))
    return cands


def detect_all_conflicts(wires: tuple[Wire, ...], zones: tuple[KeepoutZone, ...],
                         cfg: LayeringConfig,
                         cmap: CongestionMap | None = None
                         ) -> tuple[list[Conflict], ConflictGraph]:
    conflicts: list[Conflict] = []
    graph = ConflictGraph()
    for w in wires:
        graph.add_node(w.wire_id)

    for i, j in pair_candidates(wires):
        c = classify_pair(wires[i], wires[j], zones, cfg, cmap)
        if c.level == ConflictLevel.HARD:
            graph.add_edge(c.wire_a, c.wire_b)
            conflicts.append(c)
        elif c.level == ConflictLevel.SOFT:
            conflicts.append(c)
        # NONE 冲突不保留（仅 hard/soft 参与分层与报告）
    return conflicts, graph


def build_hard_graph(conflicts: list[Conflict]) -> ConflictGraph:
    graph = ConflictGraph()
    for c in conflicts:
        graph.add_node(c.wire_a)
        graph.add_node(c.wire_b)
        if c.level == ConflictLevel.HARD:
            graph.add_edge(c.wire_a, c.wire_b)
    return graph
