"""飞线生成：2-pin 单线 / 3-pin share / ≥4-pin MST。

供 JSON loader 与 xlsx loader 共用。
"""
from __future__ import annotations

import math

from ..model import Net, Pin, Wire, NetClass

_SHARE_SHORT_IGNORE = 10.0   # 3-pin share 的短段（圆内）短于此值则忽略


def _wire(n: Net, i: int, a: Pin, b: Pin) -> Wire:
    return Wire(f"{n.net_id}_W{i}", n.net_id, a.pos, b.pos, n.width, n.clearance)


def share_wires(n: Net, start_i: int) -> list[Wire]:
    """3-pin share：外 pin → 较远内 pin 长段 + 两内 pin 间短段。

    直角 L 形（外→内拐点→内）：长段按扇区分层，短段在圆内、太短可忽略。
    """
    outer = max(n.pins, key=lambda p: math.hypot(p.pos.x, p.pos.y))
    inners = [p for p in n.pins if p is not outer]
    far = max(inners, key=lambda p: p.pos.dist(outer.pos))
    other = inners[0] if inners[0] is not far else inners[1]
    wires = [_wire(n, start_i, outer, far)]
    if far.pos.dist(other.pos) >= _SHARE_SHORT_IGNORE:
        wires.append(_wire(n, start_i + 1, far, other))
    return wires


def mst_wires(n: Net, start_i: int) -> list[Wire]:
    """多 pin net（≥4）用 Prim 最小生成树连成飞线，总长更短、交叉更少。

    O(n²)，n 为 pin 数（通常 ≤9），无需空间索引。
    """
    pins = n.pins
    npins = len(pins)
    in_tree = [False] * npins
    dist = [math.inf] * npins
    parent = [-1] * npins
    dist[0] = 0.0
    wires: list[Wire] = []
    for _ in range(npins):
        u = min((i for i in range(npins) if not in_tree[i]), key=lambda i: dist[i])
        in_tree[u] = True
        if parent[u] != -1:
            wires.append(_wire(n, start_i + len(wires), pins[parent[u]], pins[u]))
        for v in range(npins):
            if not in_tree[v]:
                d = pins[u].pos.dist(pins[v].pos)
                if d < dist[v]:
                    dist[v] = d
                    parent[v] = u
    return wires


def generate_wires(nets: tuple[Net, ...], warnings: list[str]) -> tuple[Wire, ...]:
    """无显式 wires 时生成飞线：2-pin 单线 / 3-pin share / ≥4-pin MST。

    只给 signal net 生成；power/ground 走 plane 层。
    """
    wires: list[Wire] = []
    for n in nets:
        if n.net_class != NetClass.SIGNAL:   # 电源/地走 plane 层，不生成飞线
            continue
        if len(n.pins) < 2:
            warnings.append(f"网络 {n.net_id} 仅有 {len(n.pins)} 个 pin，跳过")
            continue
        i0 = len(wires)
        if len(n.pins) == 2:
            wires.append(_wire(n, i0, n.pins[0], n.pins[1]))
        elif len(n.pins) == 3:
            wires.extend(share_wires(n, i0))
        else:
            wires.extend(mst_wires(n, i0))
    return tuple(wires)
