"""metrics + optimizer 单元测试。"""
from __future__ import annotations

import math
from collections import Counter

from probe_layer.model import Point, Wire, ConflictLevel
from probe_layer.config import LayeringConfig
from probe_layer.core import metrics, optimizer as opt
from probe_layer.core import conflict_classifier as cc
from probe_layer.core import post_process as pp


def W(wid, net, x1, y1, x2, y2, width=0.05, clearance=0.05):
    return Wire(wid, net, Point(x1, y1), Point(x2, y2), width, clearance)


# ---------------------------------------------------------------------------
# metrics
# ---------------------------------------------------------------------------

def test_sector_index():
    assert metrics.sector_index(0.0, 45.0) == 0
    assert metrics.sector_index(44.9, 45.0) == 0
    assert metrics.sector_index(45.0, 45.0) == 1
    assert metrics.sector_index(359.0, 45.0) == 7
    assert metrics.sector_index(180.0, 45.0) == 4


def test_soft_crossings():
    pairs = [("a", "b"), ("c", "d")]
    assert metrics.soft_crossings({"a": 1, "b": 1, "c": 1, "d": 2}, pairs) == 1
    assert metrics.soft_crossings({"a": 1, "b": 2, "c": 1, "d": 2}, pairs) == 0


def test_count_imbalance():
    assert metrics.count_imbalance({1: 10, 2: 10}) == 0.0
    assert metrics.count_imbalance({1: 5, 2: 15}) == 1.0  # (15-5)/10
    assert metrics.count_imbalance({1: 5}) == 0.0


def test_sector_imbalance_ignores_empty_sectors():
    # 两层层、两个有线的扇区；扇区 9 是空扇区，不应影响结果
    ls = {1: Counter({0: 5, 1: 5}), 2: Counter({0: 5, 1: 5})}
    assert metrics.sector_imbalance(ls, 20) == 0.0
    ls2 = {1: Counter({0: 10, 1: 0}), 2: Counter({0: 0, 1: 10})}
    # 每个扇区 (10-0)=10，两个扇区 → 20 / 20 = 1.0
    assert abs(metrics.sector_imbalance(ls2, 20) - 1.0) < 1e-9


# ---------------------------------------------------------------------------
# optimizer
# ---------------------------------------------------------------------------

def test_optimizer_reduces_soft_crossings():
    cfg = LayeringConfig(sa_seed=1, sa_initial_temp=20.0, sa_cooling=0.99, sa_max_steps=3000)
    # 8 条都过圆心的交叉线，两两软冲突（低拥塞）
    wires = []
    for i in range(8):
        ang = i * math.pi / 8
        wires.append(W(f"w{i}", f"n{i}",
                       -math.cos(ang), -math.sin(ang), math.cos(ang), math.sin(ang)))
    conflicts, graph = cc.detect_all_conflicts(tuple(wires), (), cfg, None)
    soft_pairs = [(c.wire_a, c.wire_b) for c in conflicts if c.level == ConflictLevel.SOFT]
    allowed = {w.wire_id: {1, 2, 3, 4} for w in wires}
    # 初始全塞第 1 层 → 全部两两交叉
    assignment = {w.wire_id: 1 for w in wires}
    before = metrics.soft_crossings(assignment, soft_pairs)
    assert before > 0
    out = opt.optimize_layering(assignment, wires=tuple(wires), soft_pairs=soft_pairs,
                                hard_graph=graph, allowed=allowed, cfg=cfg)
    after = metrics.soft_crossings(out, soft_pairs)
    assert after < before
    assert pp.verify_hard_free(out, graph) == []
    assert set(out.values()) <= {1, 2, 3, 4}


def test_optimizer_respects_allowed_layers():
    cfg = LayeringConfig(sa_seed=1, sa_max_steps=500)
    wires = (W("a", "n1", 0, 0, 1, 1), W("b", "n2", 0, 1, 1, 0))
    conflicts, graph = cc.detect_all_conflicts(wires, (), cfg, None)
    soft_pairs = [(c.wire_a, c.wire_b) for c in conflicts if c.level == ConflictLevel.SOFT]
    allowed = {"a": {1}, "b": {2}}          # 各自只能待在一层 → 无可行移动
    assignment = {"a": 1, "b": 2}
    out = opt.optimize_layering(assignment, wires=wires, soft_pairs=soft_pairs,
                                hard_graph=graph, allowed=allowed, cfg=cfg)
    assert out == {"a": 1, "b": 2}
