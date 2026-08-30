"""pipeline：loader → 分层 → 后处理 → 结果 的编排。"""
from __future__ import annotations

import dataclasses
import math
from collections import defaultdict

from .config import LayeringConfig
from .model import (LayeringResult, LayerInfo, NetClass, ConflictLevel, Wire)
from .io.loader import LoadedData
from .cancel import LayeringCancelled, check_cancel
from .io import allegro_skill as askill
from .core import geometry as geo
from .core import congestion
from .core import conflict_classifier as cc
from .core import layer_stack as lstack
from .core import layer_packing as packing
from .core import optimizer as opt
from .core import metrics
from .core import graph_coloring as coloring
from .core import post_process as pp


def _usable_area(wires: tuple[Wire, ...], keepouts) -> float:
    if not wires:
        return 0.0
    xs = [p.x for w in wires for p in (w.start, w.end)]
    ys = [p.y for w in wires for p in (w.start, w.end)]
    area = (max(xs) - min(xs)) * (max(ys) - min(ys))
    for z in keepouts:
        if isinstance(z, geo.RectZone):
            area -= (z.xmax - z.xmin) * (z.ymax - z.ymin)
        else:
            area -= math.pi * z.radius * z.radius
    return max(area, 0.0)


def apply_feedback_penalties(data: LoadedData, unrouted: set[str],
                             amount: float = 1.0) -> LoadedData:
    """对未布通线累加 penalty（增量修复用）。返回新的 LoadedData。"""
    wires = tuple(
        Wire(w.wire_id, w.net_id, w.start, w.end, w.width, w.clearance,
             w.penalty + amount if w.wire_id in unrouted else w.penalty)
        for w in data.wires)
    return LoadedData(data.stack, data.signal_groups, data.net_groups, data.nets,
                      data.keepouts, wires, data.units, data.warnings)


def run_once(data: LoadedData, cfg: LayeringConfig,
             on_progress=None, cancel_event=None) -> LayeringResult:
    """单轮分层。`on_progress(percent, message)` 可选进度回调（0~100）；
    `cancel_event` 可选取消事件（is_set() 时抛 LayeringCancelled）。"""
    def emit(pct: float, msg: str) -> None:
        if on_progress:
            on_progress(pct, msg)

    emit(3, "分离电源/地")
    trace_nets, plane_nets = lstack.split_trace_plane(data.nets, cfg)
    trace_net_ids = {n.net_id for n in trace_nets}
    wires = tuple(w for w in data.wires if w.net_id in trace_net_ids)

    group_of = {n.net_id: (n.signal_group_id or "default") for n in trace_nets}
    wire_group_of = {w.wire_id: group_of.get(w.net_id, "default") for w in wires}
    allowed = {w.wire_id: lstack.wire_allowed_layers(w, trace_nets, data.signal_groups,
                                                     data.stack) for w in wires}
    pins = tuple(p for n in trace_nets for p in n.pins)

    check_cancel(cancel_event)
    emit(12, "构建拥塞图")
    cmap0 = congestion.build_congestion_map(wires, data.keepouts, pins, cfg)
    check_cancel(cancel_event)
    emit(22, "冲突检测")
    conflicts, hard_graph = cc.detect_all_conflicts(wires, data.keepouts, cfg, cmap0)
    check_cancel(cancel_event)

    usable = _usable_area(wires, data.keepouts)
    lb = packing.capacity_lower_bound(wires, wire_group_of, usable, cfg)

    warnings: list[str] = list(data.warnings)
    if cfg.method == "dsatur":
        try:
            assignment = coloring.dsatur_color(hard_graph, allowed=allowed)
        except coloring.UncolorableError as e:
            warnings.append(str(e))
            assignment = {}
    else:
        emit(32, "扇区轮询分层")
        assignment = packing.pack_layers(
            wires, allowed, data.keepouts, pins, cfg, hard_graph,
            on_progress=lambda f: emit(32 + f * 18, "扇区轮询分层"),
            cancel_event=cancel_event)
        # 软冲突（交叉）最小化 + 均衡精修
        soft_pairs = [(c.wire_a, c.wire_b) for c in conflicts
                      if c.level == ConflictLevel.SOFT]
        layers = sorted(set(assignment.values()))
        # 先跑一次快速贪心（系统化下降），作为精修的起点 / 对比基线
        if cfg.optimizer != "none":
            emit(52, "贪心交叉最小化")
            assignment = packing.minimize_crossings(
                assignment, soft_pairs, layers, hard_graph,
                max_passes=cfg.minimize_crossings_passes,
                cancel_event=cancel_event)
            check_cancel(cancel_event)
        # 再在贪心结果上做模拟退火，跳出贪心局部最优
        if cfg.optimizer == "sa":
            best = assignment
            best_soft = metrics.soft_crossings(best, soft_pairs)
            for r in range(max(1, cfg.sa_restarts)):
                c = dataclasses.replace(cfg, sa_seed=cfg.sa_seed + r)
                cand = opt.optimize_layering(
                    best, wires=wires, soft_pairs=soft_pairs,
                    hard_graph=hard_graph, allowed=allowed, cfg=c,
                    on_progress=lambda f: emit(55 + f * 33, "模拟退火精修"),
                    cancel_event=cancel_event)
                check_cancel(cancel_event)
                s = metrics.soft_crossings(cand, soft_pairs)
                if s < best_soft:
                    best, best_soft = cand, s
            assignment = best

    check_cancel(cancel_event)
    emit(90, "后处理与人工兜底")
    viol = pp.verify_hard_free(assignment, hard_graph)
    manual_nets: list[str] = []
    manual_wires: set[str] = set()
    if viol:
        # 少量分不开的线不强塞：从自动分层里移除，标记留给人工 route
        manual_wires = {w for pair in viol for w in pair}
        manual_nets = sorted({w.net_id for w in wires if w.wire_id in manual_wires})
        for w in manual_wires:
            assignment.pop(w, None)
        warnings.append(f"{len(manual_nets)} 条线需人工 route（同层硬冲突无法自动分层）: {manual_nets}")

    soft_per_layer = pp.soft_conflicts_per_layer(assignment, conflicts)
    detour, via = pp.collect_layer_marks(wires, assignment, conflicts, data.keepouts, cfg)
    occ_per_layer = pp.max_occupancy_per_layer(assignment, wires, data.keepouts, pins, cfg)

    net_by_id = {n.net_id: n for n in data.nets}
    by_layer: dict[int, list[Wire]] = defaultdict(list)
    for w in wires:
        if w.wire_id in assignment:
            by_layer[assignment[w.wire_id]].append(w)

    layer_infos: list[LayerInfo] = []
    for layer in sorted(by_layer):
        ws = by_layer[layer]
        nets = sorted({w.net_id for w in ws})
        groups = sorted({net_by_id[n].signal_group_id
                         for n in nets if n in net_by_id and net_by_id[n].signal_group_id})
        layer_infos.append(LayerInfo(
            layer_index=layer,
            kind=data.stack.kind_of(layer) if data.stack else "signal",
            signal_groups=tuple(groups),
            wires=tuple(sorted(w.wire_id for w in ws)),
            nets=tuple(nets),
            soft_conflict_count=soft_per_layer.get(layer, 0),
            max_occupancy=round(occ_per_layer.get(layer, 0.0), 4),
            requires_detour=tuple(sorted(detour.get(layer, set()))),
            requires_endpoint_via=tuple(sorted(via.get(layer, set()))),
        ))

    # plane 层（仅 net 列表）
    if plane_nets and cfg.plane_nets_excluded and data.stack is not None:
        for pl in data.stack.plane_layers():
            layer_infos.append(LayerInfo(layer_index=pl, kind="plane",
                                         nets=tuple(sorted(n.net_id for n in plane_nets))))

    layer_infos.sort(key=lambda li: li.layer_index)

    unassigned = [w.wire_id for w in wires
                  if w.wire_id not in assignment and w.wire_id not in manual_wires]
    if unassigned:
        warnings.append(f"以下线未能在允许层内分配: {unassigned}")

    hard = tuple(c for c in conflicts if c.level == ConflictLevel.HARD)
    soft = tuple(c for c in conflicts if c.level == ConflictLevel.SOFT)
    emit(100, "完成")
    return LayeringResult(
        layers=tuple(layer_infos),
        assignment=assignment,
        plane_nets=tuple(sorted(n.net_id for n in plane_nets)),
        hard_conflicts=hard,
        soft_conflicts=soft,
        method=cfg.method,
        iterations_used=1,
        capacity_lower_bound=lb,
        warnings=tuple(warnings),
        manual_route_nets=tuple(manual_nets),
    )


def run(data: LoadedData, cfg: LayeringConfig,
        feedback_path: str | None = None,
        on_progress=None, cancel_event=None) -> LayeringResult:
    """单轮分层；若提供 feedback 文件则迭代（占位，P3 真实闭环）。

    可选 `on_progress(percent, message)` / `cancel_event`（见 run_once）。
    """
    result = run_once(data, cfg, on_progress=on_progress, cancel_event=cancel_event)
    if not cfg.feedback_enabled or not feedback_path:
        return result

    iterations = 1
    for it in range(2, cfg.max_loop_iterations + 1):
        fb = askill.parse_route_feedback(feedback_path)
        if not fb.unrouted_all():
            break
        data = apply_feedback_penalties(data, fb.unrouted_all())
        result = run_once(data, cfg, on_progress=on_progress, cancel_event=cancel_event)
        iterations = it
        if not fb.unrouted_all():
            break
    # 更新迭代计数
    return LayeringResult(
        layers=result.layers, assignment=result.assignment,
        plane_nets=result.plane_nets, hard_conflicts=result.hard_conflicts,
        soft_conflicts=result.soft_conflicts, method=result.method,
        iterations_used=iterations, capacity_lower_bound=result.capacity_lower_bound,
        warnings=result.warnings, manual_route_nets=result.manual_route_nets,
    )
