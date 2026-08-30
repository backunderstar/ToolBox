"""Allegro 导出 → 内部模型（JSON 规范，双模式：wires 或 pins 生成）。"""
from __future__ import annotations

import json
from collections import defaultdict

from ..model import (Point, Units, LayerDef, LayerStack, SignalGroup, NetGroup,
                     NetClass, Net, Pin, Wire)
from ..core import keepout as ko
from .loader import LoadedData
from .wire_gen import generate_wires


class _NetMeta:
    __slots__ = ("width", "clearance")

    def __init__(self, width: float, clearance: float):
        self.width = width
        self.clearance = clearance


def _parse_nets(raw_nets: list[dict], warnings: list[str]) -> tuple[tuple[Net, ...], dict[str, _NetMeta]]:
    nets: list[Net] = []
    meta: dict[str, _NetMeta] = {}
    seen: set[str] = set()
    for nd in raw_nets:
        nid = nd["net_id"]
        if nid in seen:
            warnings.append(f"重复 net_id {nid}，已跳过")
            continue
        seen.add(nid)
        pins = tuple(Pin(p["pin_id"], Point(float(p["x"]), float(p["y"])))
                     for p in nd.get("pins", []))
        width = float(nd.get("width", 0.05))
        clearance = float(nd.get("clearance", 0.05))
        nc = NetClass(nd.get("net_class", "signal"))
        nets.append(Net(nid, nc, nd.get("signal_group_id"), nd.get("net_group_id"),
                        pins, width, clearance))
        meta[nid] = _NetMeta(width, clearance)
    return tuple(nets), meta


class AllegroJsonLoader:
    def load(self, path: str) -> LoadedData:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        warnings: list[str] = []

        units = Units(d.get("units", "mm"))

        stack: LayerStack | None = None
        if "layer_stack" in d:
            ls = d["layer_stack"]
            layers = tuple(
                LayerDef(int(l["index"]), l["name"], l.get("kind", "signal"),
                         l.get("preferred_dir", "any"))
                for l in ls["layers"])
            stack = LayerStack(layers, ls.get("via", "through"))

        nets, net_meta = _parse_nets(d.get("nets", []), warnings)

        groups = tuple(SignalGroup(g["group_id"], tuple(int(x) for x in g["allowed_layers"]),
                                   tuple(g.get("net_ids", [])))
                       for g in d.get("signal_groups", []))
        ngroups = tuple(NetGroup(g["group_id"], g.get("kind", ""), tuple(g.get("net_ids", [])),
                                 bool(g.get("same_layer", True)))
                        for g in d.get("net_groups", []))

        # 无 groups → 退化单组模式（所有 signal 层）
        if not groups and stack is not None:
            sig_nets = [n.net_id for n in nets if n.net_class == NetClass.SIGNAL]
            groups = (SignalGroup("default", tuple(stack.signal_layers()), tuple(sig_nets)),)

        # 无 stack → 从 groups 推断最小层叠
        if stack is None:
            all_layers = sorted({l for g in groups for l in g.allowed_layers})
            if not all_layers:
                all_layers = [1]
            stack = LayerStack(tuple(LayerDef(i, f"L{i}", "signal", "any") for i in all_layers))

        zones = ko.load_keepouts(d.get("keepouts", []))

        # wires（双模式）
        if d.get("wires"):
            wires: list[Wire] = []
            seen_w: set[str] = set()
            for w in d["wires"]:
                wid = w["wire_id"]
                if wid in seen_w:
                    warnings.append(f"重复 wire_id {wid}，已跳过")
                    continue
                seen_w.add(wid)
                nid = w["net_id"]
                m = net_meta.get(nid, _NetMeta(0.05, 0.05))
                wires.append(Wire(wid, nid,
                                  Point(float(w["from"]["x"]), float(w["from"]["y"])),
                                  Point(float(w["to"]["x"]), float(w["to"]["y"])),
                                  m.width, m.clearance))
            # 过滤零长
            wires = [w for w in wires if w.start.dist(w.end) > 1e-9]
        else:
            wires = list(generate_wires(nets, warnings))

        return LoadedData(stack, groups, ngroups, nets, zones, tuple(wires), units,
                          tuple(warnings))
