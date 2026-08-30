"""后处理：校验、层标记、软冲突统计、层拥塞验证。"""
from __future__ import annotations

from collections import defaultdict

from ..model import (Wire, KeepoutZone, Pin, Conflict, ConflictLevel, ConflictGraph)
from ..config import LayeringConfig
from . import congestion
from . import keepout as ko


def verify_hard_free(assignment: dict[str, int],
                     graph: ConflictGraph) -> list[tuple[str, str]]:
    viol: list[tuple[str, str]] = []
    for a, b in graph.edges():
        if a in assignment and b in assignment and assignment[a] == assignment[b]:
            viol.append((a, b))
    return viol


def soft_conflicts_per_layer(assignment: dict[str, int],
                             conflicts: list[Conflict]) -> dict[int, int]:
    d: dict[int, int] = defaultdict(int)
    for c in conflicts:
        if c.level == ConflictLevel.SOFT:
            la, lb = assignment.get(c.wire_a), assignment.get(c.wire_b)
            if la is not None and la == lb:
                d[la] += 1
    return dict(d)


def collect_layer_marks(wires: tuple[Wire, ...], assignment: dict[str, int],
                        conflicts: list[Conflict], zones: tuple[KeepoutZone, ...],
                        cfg: LayeringConfig
                        ) -> tuple[dict[int, set[str]], dict[int, set[str]]]:
    """返回 (requires_detour, requires_endpoint_via)：层 -> wire_id 集合。"""
    detour: dict[int, set[str]] = defaultdict(set)
    via: dict[int, set[str]] = defaultdict(set)

    if cfg.keepout_enabled and zones:
        for w in wires:
            if w.wire_id not in assignment:
                continue
            margin = w.width / 2.0 + w.clearance + cfg.keepout_margin_factor * w.width
            if ko.zones_crossed_by(w, zones, margin):
                detour[assignment[w.wire_id]].add(w.wire_id)

    for c in conflicts:
        if c.level == ConflictLevel.SOFT:
            la = assignment.get(c.wire_a)
            if la is not None:
                d1, d2 = c.dist_to_endpoints
                if d1 <= cfg.r_end or d2 <= cfg.r_end:
                    via[la].add(c.wire_a)
                    via[la].add(c.wire_b)
    return dict(detour), dict(via)


def max_occupancy_per_layer(assignment: dict[str, int], wires: tuple[Wire, ...],
                            zones: tuple[KeepoutZone, ...], pins: tuple[Pin, ...],
                            cfg: LayeringConfig) -> dict[int, float]:
    by_layer: dict[int, list[Wire]] = defaultdict(list)
    for w in wires:
        if w.wire_id in assignment:
            by_layer[assignment[w.wire_id]].append(w)
    out: dict[int, float] = {}
    for layer, ws in by_layer.items():
        cmap = congestion.build_congestion_map(tuple(ws), zones, pins, cfg)
        out[layer] = congestion.max_occupancy(cmap)
    return out
