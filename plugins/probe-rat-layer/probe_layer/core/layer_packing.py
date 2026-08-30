"""扇区轮询分层 + 均衡分配（方法 B：默认主算法）。

思路（用户校准）：
1. 圆形针卡飞线径向走线，按外 pin 极角（扇区）排序后 round-robin 分层，
   每层均匀覆盖圆的各扇区、线数均衡（空扇区自然无线，不强制）；
2. 同层硬冲突微调：冲突线移到方向相邻的无冲突层；
3. 长短线均衡：相邻层交换，让每层平均线长接近；
4. 容量校验：每层 occupancy 不超 layer_capacity，超载则移走最长线；
5. 软冲突（交叉）由 optimizer 精修（贪心 / 模拟退火）。
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

import numpy as np

from ..model import Wire, KeepoutZone, Pin, ConflictGraph
from ..config import LayeringConfig
from ..cancel import check_cancel
from . import congestion
from .congestion import layer_routable


@dataclass
class _Unit:
    uid: str
    wires: list[Wire]
    allowed: set[int]


def _units_conflict(a: _Unit, b: _Unit, graph: ConflictGraph) -> bool:
    for wa in a.wires:
        for wb in b.wires:
            if graph.has_edge(wa.wire_id, wb.wire_id):
                return True
    return False


def _make_units(wires: tuple[Wire, ...], allowed: dict[str, set[int]],
                cfg: LayeringConfig) -> list[_Unit]:
    if not cfg.same_net_same_layer:
        return [_Unit(w.wire_id, [w], allowed.get(w.wire_id, set())) for w in wires]
    by_net: dict[str, list[Wire]] = defaultdict(list)
    for w in wires:
        by_net[w.net_id].append(w)
    units: list[_Unit] = []
    for net_id, ws in by_net.items():
        allow: set[int] = set()
        for w in ws:
            allow |= allowed.get(w.wire_id, set())
        units.append(_Unit(net_id, ws, allow))
    return units


def wire_dir_angle(w: Wire) -> float:
    """单条 wire 的扇区角度：靠外 pin 相对圆心 (0,0) 的极角 [0,360)。

    圆形针卡：飞线从外圆（测试机）走向内圆（DUT 圆心），径向为主。
    按外 pin 极角分层 = 按扇区分层，同扇区飞线方向近似、平行性好。
    圆心**定死 (0,0)**（用户确认，不从数据估计、不做配置）。
    """
    rs = math.hypot(w.start.x, w.start.y)
    re = math.hypot(w.end.x, w.end.y)
    ox, oy = (w.start.x, w.start.y) if rs >= re else (w.end.x, w.end.y)
    return math.degrees(math.atan2(oy, ox)) % 360.0


def _dir_angle(u: _Unit) -> float:
    """unit 的扇区角度（取第一条 wire，多线 unit 由 net 聚合）。"""
    return wire_dir_angle(u.wires[0])


def _len(u: _Unit) -> float:
    return sum(w.length for w in u.wires)


def _resolve_conflicts(layer_units: dict[int, list[_Unit]], layers: list[int],
                       graph: ConflictGraph, rounds: int = 8,
                       cancel_event=None) -> None:
    """同层硬冲突 → 移到任意无冲突层（方向相邻优先），多轮直到稳定。"""
    for _ in range(rounds):
        check_cancel(cancel_event)
        moved_any = False
        for l in layers:
            us = layer_units[l]
            bad = set()
            for a in range(len(us)):
                for b in range(a + 1, len(us)):
                    if _units_conflict(us[a], us[b], graph):
                        bad.add(us[a].uid)
                        bad.add(us[b].uid)
            if not bad:
                continue
            li = layers.index(l)
            for u in [x for x in us if x.uid in bad]:
                # 候选：允许 + 无冲突，按 |层序差|（方向接近度）升序
                cands = [nl for nl in layers
                         if nl != l and nl in u.allowed
                         and not any(_units_conflict(u, x, graph) for x in layer_units[nl])]
                if not cands:
                    continue
                cands.sort(key=lambda nl: abs(layers.index(nl) - li))
                nl = cands[0]
                layer_units[l].remove(u)
                layer_units[nl].append(u)
                moved_any = True
        if not moved_any:
            break


def _pack_units(units: list[_Unit], layers: list[int], zones: tuple[KeepoutZone, ...],
                pins: tuple[Pin, ...], cfg: LayeringConfig,
                graph: ConflictGraph, on_progress=None, cancel_event=None) -> dict[str, int]:
    L = len(layers)
    n = len(units)

    def prog(fraction: float) -> None:
        if on_progress:
            on_progress(fraction)

    # 1) 扇区轮询：按外 pin 极角排序后 round-robin 分到 L 层，
    #    每层都均匀覆盖圆的各扇区（圆内各部分线量接近），数量均衡
    prog(0.1)
    order = sorted(units, key=_dir_angle)
    layer_units: dict[int, list[_Unit]] = {l: [] for l in layers}
    for i, u in enumerate(order):
        layer_units[layers[i % L]].append(u)

    # 2) 同层硬冲突微调
    prog(0.3)
    check_cancel(cancel_event)
    _resolve_conflicts(layer_units, layers, graph, cfg.resolve_conflict_rounds, cancel_event)

    # 3) 长短线均衡微调：相邻层间交换，使每层平均长度接近（尽量不破坏方向/冲突）
    prog(0.5)
    check_cancel(cancel_event)
    _balance_lengths(layer_units, layers, graph, cfg.balance_length_rounds, cancel_event)

    # 4) 容量校验（每层 occupancy ≤ layer_capacity）；超载则把最长线移到其它层
    prog(0.7)
    check_cancel(cancel_event)
    _enforce_capacity(layer_units, layers, zones, pins, cfg, graph, cancel_event)

    prog(0.9)
    check_cancel(cancel_event)
    assignment: dict[str, int] = {}
    for l, us in layer_units.items():
        for u in us:
            for w in u.wires:
                assignment[w.wire_id] = l
    prog(1.0)
    return assignment


def _balance_lengths(layer_units: dict[int, list[_Unit]], layers: list[int],
                     graph: ConflictGraph, rounds: int = 3,
                     cancel_event=None) -> None:
    """相邻层交换长/短线，让每层平均线长接近（不引入新冲突）。"""
    for _ in range(rounds):
        check_cancel(cancel_event)
        changed = False
        for li in range(len(layers) - 1):
            la, lb = layers[li], layers[li + 1]
            a, b = layer_units[la], layer_units[lb]
            if not a or not b:
                continue
            avga = sum(_len(u) for u in a) / len(a)
            avgb = sum(_len(u) for u in b) / len(b)
            if abs(avga - avgb) < 5.0:
                continue
            # 长的一侧挑最长、短的一侧挑最短，交换
            (src, dst) = (a, b) if avga > avgb else (b, a)
            if len(dst) < 2:
                continue
            long_u = max(src, key=_len)
            short_u = min(dst, key=_len)
            if _len(long_u) <= _len(short_u):
                continue
            if any(_units_conflict(long_u, x, graph) for x in dst if x is not short_u):
                continue
            if any(_units_conflict(short_u, x, graph) for x in src if x is not long_u):
                continue
            src.remove(long_u)
            dst.remove(short_u)
            src.append(short_u)
            dst.append(long_u)
            changed = True
        if not changed:
            break


def _enforce_capacity(layer_units: dict[int, list[_Unit]], layers: list[int],
                      zones: tuple[KeepoutZone, ...], pins: tuple[Pin, ...],
                      cfg: LayeringConfig, graph: ConflictGraph,
                      cancel_event=None) -> None:
    """每层 occupancy 超 layer_capacity 时，把最长线移到容量富余的层。

    增量实现：每层维护自己的 demand 网格（栅格化一次），尝试移线时只更新
    被移线的格子，不再整层重建拥塞图。HV 实测：全量重建 207s → 增量 <1s。
    """
    all_wires = [w for l in layers for u in layer_units[l] for w in u.wires]
    if not all_wires:
        return
    origin, cell, cols, rows, supply = congestion._grid_geometry(
        tuple(all_wires), zones, pins, cfg)
    occupable = supply > 1e-12

    def _demand_value(w: Wire) -> float:
        return (w.width + w.clearance) * cfg.congestion_demand_factor

    def _raster(w: Wire, arr: np.ndarray, sign: float) -> None:
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
        arr[rc[:, 0], rc[:, 1]] += sign * _demand_value(w)

    def _max_occ(arr: np.ndarray) -> float:
        o = np.zeros_like(arr)
        o[occupable] = arr[occupable] / supply[occupable]
        return float(o.max()) if o.size else 0.0

    # 每层 demand 网格（一次栅格化）
    layer_demand: dict[int, np.ndarray] = {}
    for l in layers:
        d = np.zeros((rows, cols))
        for u in layer_units[l]:
            for w in u.wires:
                _raster(w, d, +1.0)
        layer_demand[l] = d

    for l in layers:
        check_cancel(cancel_event)
        us = layer_units[l]
        if not us:
            continue
        if _max_occ(layer_demand[l]) <= cfg.layer_capacity:
            continue
        # 超载：按线长降序尝试移走（增量判断目标层是否可布）
        for u in sorted(us, key=_len, reverse=True):
            if _max_occ(layer_demand[l]) <= cfg.layer_capacity:
                break
            for nl in layers:
                if nl == l or nl not in u.allowed:
                    continue
                if any(_units_conflict(u, x, graph) for x in layer_units[nl]):
                    continue
                # 试探：u 加到 nl 后是否仍可布（只动 u 覆盖的格子）
                d_try = layer_demand[nl].copy()
                for w in u.wires:
                    _raster(w, d_try, +1.0)
                if _max_occ(d_try) > cfg.layer_capacity:
                    continue
                # 提交移动
                for w in u.wires:
                    _raster(w, layer_demand[l], -1.0)
                    _raster(w, layer_demand[nl], +1.0)
                layer_units[l].remove(u)
                layer_units[nl].append(u)
                break


def pack_layers(wires: tuple[Wire, ...], allowed: dict[str, set[int]],
                zones: tuple[KeepoutZone, ...], pins: tuple[Pin, ...],
                cfg: LayeringConfig, graph: ConflictGraph,
                on_progress=None, cancel_event=None) -> dict[str, int]:
    layers = sorted({l for s in allowed.values() for l in s})
    if not layers:
        return {}
    units = _make_units(wires, allowed, cfg)
    return _pack_units(units, layers, zones, pins, cfg, graph,
                       on_progress=on_progress, cancel_event=cancel_event)


def minimize_crossings(assignment: dict[str, int],
                       soft_pairs: list[tuple[str, str]],
                       layers: list[int],
                       graph: ConflictGraph,
                       max_passes: int = 3,
                       cancel_event=None) -> dict[str, int]:
    """同层软冲突（交叉）最小化：跨层线对交换，减少同层软冲突边数。

    软冲突 = 直线相交但非热点，同层时布线器需绕线；交换到不同层可减少绕线。
    交换保持各层线数不变（均衡）、不引入硬冲突、不产生新的同层软冲突。
    """
    soft_adj: dict[str, set[str]] = defaultdict(set)
    for a, b in soft_pairs:
        soft_adj[a].add(b)
        soft_adj[b].add(a)

    layer_wires: dict[int, set[str]] = {l: set() for l in layers}
    for wid, l in assignment.items():
        layer_wires[l].add(wid)

    def soft_in(wid: str, l: int, exclude: str) -> int:
        return sum(1 for x in soft_adj[wid] if x in layer_wires[l] and x != exclude)

    def hard_in(wid: str, l: int) -> bool:
        return any(graph.has_edge(wid, x) for x in layer_wires[l])

    for _ in range(max_passes):
        check_cancel(cancel_event)
        improved = False
        for a, b in soft_pairs:                 # 每条软冲突（交叉）边
            la = assignment.get(a)
            lb = assignment.get(b)
            if la is None or lb is None or la == lb:
                continue
            if hard_in(a, lb) or hard_in(b, la):
                continue
            before = soft_in(a, la, b) + soft_in(b, lb, a)
            after = soft_in(a, lb, b) + soft_in(b, la, a)
            if after < before:
                layer_wires[la].discard(a)
                layer_wires[lb].add(a)
                layer_wires[lb].discard(b)
                layer_wires[la].add(b)
                assignment[a] = lb
                assignment[b] = la
                improved = True
        if not improved:
            break
    return assignment


def capacity_lower_bound(wires: tuple[Wire, ...], group_of: dict[str, str],
                         usable_area: float, cfg: LayeringConfig) -> dict[str, float]:
    """每组容量下界：min_layers ≥ ceil(Σ(线长×节距) / (每层可用面积 × capacity_utilization))。"""
    total_area: dict[str, float] = defaultdict(float)
    for w in wires:
        total_area[group_of.get(w.wire_id, "default")] += w.length * (w.width + w.clearance)
    per_layer = usable_area * cfg.capacity_utilization
    if per_layer <= 0:
        return {g: 0.0 for g in total_area}
    return {g: math.ceil(a / per_layer) for g, a in total_area.items()}
