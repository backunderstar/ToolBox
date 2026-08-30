"""probe_layer 单元测试（pytest）。"""
from __future__ import annotations

import math
import os

import pytest

from probe_layer.model import (
    Point, LayerDef, LayerStack, SignalGroup, Net, NetClass, Pin, Wire,
    RectZone, CircleZone, ConflictLevel,
)
from probe_layer.config import LayeringConfig
from probe_layer.core import geometry as geo
from probe_layer.core import keepout as ko
from probe_layer.core import layer_stack as lstack
from probe_layer.core import congestion
from probe_layer.core import conflict_classifier as cc
from probe_layer.core import graph_coloring as gc
from probe_layer.core import layer_packing as packing
from probe_layer.core import post_process as pp
from probe_layer.io.loader import make_loader
from probe_layer.io import allegro_skill as askill
from probe_layer import pipeline


def W(wid, net, x1, y1, x2, y2, width=0.05, clearance=0.05):
    return Wire(wid, net, Point(x1, y1), Point(x2, y2), width, clearance)


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------

def test_seg_seg_intersection():
    p = geo.seg_seg_intersection(Point(0, 0), Point(2, 2), Point(0, 2), Point(2, 0))
    assert p is not None and abs(p.x - 1.0) < 1e-9 and abs(p.y - 1.0) < 1e-9
    assert geo.seg_seg_intersection(Point(0, 0), Point(1, 0), Point(0, 1), Point(1, 1)) is None


def test_seg_seg_min_distance():
    # 平行错开，距离 = 1
    d = geo.seg_seg_min_distance(Point(0, 0), Point(2, 0), Point(0, 1), Point(2, 1))
    assert abs(d - 1.0) < 1e-9
    assert geo.seg_seg_min_distance(Point(0, 0), Point(2, 2), Point(0, 2), Point(2, 0)) == 0.0


def test_clearance_gap():
    wa = W("a", "n1", 0, 0, 1, 0, width=0.1, clearance=0.1)
    wb = W("b", "n2", 0, 1, 1, 1, width=0.1, clearance=0.1)
    # min_allowed = (0.05+0.05)*2 = 0.2；实际距离 1 → gap = -0.8（满足）
    assert geo.clearance_gap(wa, wb, 1.0) < 0
    assert geo.clearance_gap(wa, wb, 0.1) > 0


# ---------------------------------------------------------------------------
# keepout
# ---------------------------------------------------------------------------

def test_zones_crossed_by():
    z = RectZone("K", 0.4, -0.5, 0.6, 0.5)
    w = W("a", "n", 0, 0, 2, 0)
    assert ko.zones_crossed_by(w, (z,)) == ("K",)
    assert ko.zones_crossed_by(W("b", "n", 0, 5, 2, 5), (z,)) == ()


def test_in_zone_overlap_length():
    z = RectZone("K", -1, -1, 1, 1)
    wa = W("a", "n1", -2, 0, 2, 0)
    wb = W("b", "n2", 0, -2, 0, 2)
    assert geo.in_zone_overlap_length(wa, wb, z) > 0
    wc = W("c", "n3", -2, 5, 2, 5)
    assert geo.in_zone_overlap_length(wa, wc, z) == 0.0


# ---------------------------------------------------------------------------
# layer_stack
# ---------------------------------------------------------------------------

def _stack():
    return LayerStack((LayerDef(1, "TOP", "signal"), LayerDef(2, "GND", "plane"),
                       LayerDef(3, "SIG1", "signal"), LayerDef(4, "SIG2", "signal")))


def test_split_trace_plane():
    nets = (Net("a", NetClass.SIGNAL, pins=(Pin("p", Point(0, 0)),)),
            Net("g", NetClass.GROUND, pins=(Pin("p", Point(0, 0)),)))
    trace, plane = lstack.split_trace_plane(nets, LayeringConfig())
    assert [n.net_id for n in trace] == ["a"]
    assert [n.net_id for n in plane] == ["g"]


def test_allowed_layers_of():
    stack = _stack()
    g = SignalGroup("G", (1, 3), ())
    assert lstack.allowed_layers_of(g, stack) == (1, 3)
    with pytest.raises(ValueError):
        lstack.allowed_layers_of(SignalGroup("G", (2,), ()), stack)


# ---------------------------------------------------------------------------
# congestion
# ---------------------------------------------------------------------------

def test_congestion_map_basic():
    cfg = LayeringConfig(congestion_grid_cell=0.5, via_area_cost=0.0, pin_density_weight=1.0)
    w = W("a", "n", 0, 0, 2, 0, width=0.05, clearance=0.05)
    cmap = congestion.build_congestion_map((w,), (), (), cfg)
    # 单条线节距 0.1（宽+间距）在 0.5 格内，占用率 = 0.1 / 0.5 = 0.2
    assert abs(congestion.max_occupancy(cmap) - 0.2) < 1e-9


def test_layer_routable():
    cfg = LayeringConfig(congestion_grid_cell=0.5)
    wires = tuple(W(f"w{i}", f"n{i}", 0, 0, 2, 0) for i in range(20))  # 20 线同走廊 → 拥塞
    ok, cmap, occ = congestion.layer_routable(wires, (), (), cfg)
    assert not ok and occ > cfg.congestion_hard_threshold


# ---------------------------------------------------------------------------
# conflict_classifier
# ---------------------------------------------------------------------------

def test_classify_endpoint_tolerance():
    cfg = LayeringConfig(r_end=1.0)
    wa = W("a", "n1", 0, 0, 2, 2)
    wb = W("b", "n2", 0, 2, 2, 0)      # 交点在 (1,1)，距两端点各 ~1.41 > r_end
    c = cc.classify_pair(wa, wb, (), cfg, None)
    assert c.level == ConflictLevel.SOFT
    assert "crossing_low_congestion" in c.reasons


def test_classify_hotspot_hard():
    cfg = LayeringConfig()
    wa = W("a", "n1", 0, 0, 2, 2)
    wb = W("b", "n2", 0, 2, 2, 0)
    # 手工构造高占用率拥塞图
    from probe_layer.core.congestion import CongestionMap
    import numpy as np
    cmap = CongestionMap(0.5, (0.0, 0.0), 6, 6,
                         np.zeros((6, 6)), np.full((6, 6), 0.5), np.full((6, 6), 0.95))
    c = cc.classify_pair(wa, wb, (), cfg, cmap)
    assert c.level == ConflictLevel.HARD
    assert "crossing_hotspot" in c.reasons


def test_classify_shared_keepout_hard():
    cfg = LayeringConfig(keepout_enabled=True)
    z = RectZone("K", -0.02, -1.0, 0.02, 1.0)   # 窄通道 → 咽喉
    wa = W("a", "n1", -2, 0, 2, 0)
    wb = W("b", "n2", 0, -2, 0, 2)
    c = cc.classify_pair(wa, wb, (z,), cfg, None)
    assert c.level == ConflictLevel.HARD
    assert "shared_keepout" in c.reasons


def test_same_net_excluded():
    wa = W("a", "n1", 0, 0, 2, 2)
    wb = W("b", "n1", 0, 2, 2, 0)      # 同 net
    assert not cc.pair_candidates((wa, wb))


# ---------------------------------------------------------------------------
# graph_coloring
# ---------------------------------------------------------------------------

def _graph(edges):
    g = cc.ConflictGraph()
    for a, b in edges:
        g.add_edge(a, b)
    return g


def test_dsatur_bipartite():
    g = _graph([("a", "b"), ("b", "c"), ("c", "d")])  # 链 → 2 层
    colors = gc.dsatur_color(g)
    assert gc.minimize_layers(colors) == 2


def test_dsatur_triangle():
    g = _graph([("a", "b"), ("b", "c"), ("c", "a")])  # 三角形 → 3 层
    colors = gc.dsatur_color(g)
    assert gc.minimize_layers(colors) == 3


def test_dsatur_allowed_domain():
    g = _graph([("a", "b")])
    colors = gc.dsatur_color(g, allowed={"a": {1, 3}, "b": {1, 3}})
    assert colors["a"] != colors["b"]


# ---------------------------------------------------------------------------
# layer_packing / post_process
# ---------------------------------------------------------------------------

def test_pack_and_verify():
    cfg = LayeringConfig()
    wires = (W("a", "n1", 0, 0, 2, 2),
             W("b", "n2", 0, 2, 2, 0),
             W("c", "n3", 0, 0, 2, -2))
    conflicts, graph = cc.detect_all_conflicts(wires, (), cfg, None)
    allowed = {w.wire_id: {1, 2, 3, 4} for w in wires}
    assignment = packing.pack_layers(wires, allowed, (), (), cfg, graph)
    assert pp.verify_hard_free(assignment, graph) == []
    assert set(assignment.values()) <= {1, 2, 3, 4}


def test_capacity_lower_bound():
    cfg = LayeringConfig(capacity_utilization=0.5)
    # 单线：长 10 × 节距 0.1 = 面积 1.0；每层可用 10*0.5=5 → lb = ceil(1/5) = 1
    wires = (W("a", "n1", 0, 0, 10, 0),)
    lb = packing.capacity_lower_bound(wires, {"a": "G"}, 10.0, cfg)
    assert lb["G"] == 1
    # 10 条长线：面积 10*1.0 = 10；每层 5 → lb = 2
    wires2 = tuple(W(f"w{i}", f"n{i}", 0, 0, 10, 0) for i in range(10))
    group_of = {f"w{i}": "G" for i in range(10)}
    lb2 = packing.capacity_lower_bound(wires2, group_of, 10.0, cfg)
    assert lb2["G"] == 2


# ---------------------------------------------------------------------------
# loader / skill / pipeline 端到端
# ---------------------------------------------------------------------------

def test_loader_parse_sample(tmp_path):
    from examples.generate_dc_sample import build_dc_sample
    data = build_dc_sample(n=6)
    path = tmp_path / "sample.json"
    path.write_text(__import__("json").dumps(data), encoding="utf-8")
    loaded = make_loader().load(str(path))
    assert len(loaded.nets) == 7          # 6 DC + 1 GND
    assert len(loaded.wires) == 6         # GND 不生成飞线
    assert loaded.stack.signal_layers() == (1, 3, 4, 5)


def test_generate_wires_mst_and_share(tmp_path):
    import json
    data = {
        "units": "mm",
        "layer_stack": {"via": "through", "layers": [
            {"index": 1, "name": "L1", "kind": "signal"},
            {"index": 2, "name": "L2", "kind": "signal"},
        ]},
        "nets": [
            # 3-pin share：外 pin (100,0)，两内 pin 相距 4mm（短段 <10mm 忽略）
            {"net_id": "S3", "net_class": "signal",
             "pins": [{"pin_id": "o", "x": 100.0, "y": 0.0},
                      {"pin_id": "i1", "x": 0.0, "y": 1.0},
                      {"pin_id": "i2", "x": 0.0, "y": 5.0}]},
            # 4-pin：MST 应生成 n-1 = 3 条线
            {"net_id": "M4", "net_class": "signal",
             "pins": [{"pin_id": "a", "x": 0.0, "y": 0.0},
                      {"pin_id": "b", "x": 1.0, "y": 0.0},
                      {"pin_id": "c", "x": 0.0, "y": 1.0},
                      {"pin_id": "d", "x": 1.0, "y": 1.0}]},
        ],
    }
    path = tmp_path / "mst.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    loaded = make_loader().load(str(path))
    by_net: dict = {}
    for w in loaded.wires:
        by_net.setdefault(w.net_id, []).append(w)
    assert len(by_net["S3"]) == 1     # 短段 4mm < 10mm，忽略
    assert len(by_net["M4"]) == 3     # MST 边数 = 点数 - 1


def test_skill_roundtrip(tmp_path):
    import json
    fb_path = tmp_path / "feedback.json"
    fb_path.write_text(json.dumps({
        "iteration": 1,
        "layers": [{"layer": 1, "unrouted_wires": ["W9"], "drc_errors": ["spacing"]}],
    }), encoding="utf-8")
    fb = askill.parse_route_feedback(str(fb_path))
    assert fb.unrouted_all() == {"W9"}
    out = tmp_path / "route.il"
    askill.generate_skill_script({1: ["NET_1"], 3: ["NET_2"]}, None, str(out))
    assert "NET_1" in out.read_text(encoding="utf-8")


def test_pipeline_end_to_end(tmp_path):
    from examples.generate_dc_sample import build_dc_sample
    data = build_dc_sample(n=12)
    path = tmp_path / "sample.json"
    path.write_text(__import__("json").dumps(data), encoding="utf-8")
    loaded = make_loader().load(str(path))

    result = pipeline.run_once(loaded, LayeringConfig(method="packing"))
    assert len(result.layers) >= 1
    assert len(result.assignment) == 12
    assert "GND" in result.plane_nets
    assert not result.warnings or all("硬冲突违规" not in w for w in result.warnings)

    # 每层占用率 ≤ 阈值（packing 不变量）
    for li in result.layers:
        if li.kind == "signal":
            assert li.max_occupancy <= LayeringConfig().congestion_hard_threshold + 1e-9
