"""层叠 / 信号组工具：允许层、过孔可达性、plane 层过滤、按组归类。"""
from __future__ import annotations

from ..model import LayerStack, SignalGroup, Net, Wire, NetClass
from ..config import LayeringConfig


def signal_layers(stack: LayerStack | None) -> tuple[int, ...]:
    return stack.signal_layers() if stack else ()


def plane_layers(stack: LayerStack | None) -> tuple[int, ...]:
    return stack.plane_layers() if stack else ()


def allowed_layers_of(group: SignalGroup, stack: LayerStack | None) -> tuple[int, ...]:
    if stack is not None:
        sig = set(stack.signal_layers())
        for idx in group.allowed_layers:
            if idx not in sig:
                raise ValueError(f"信号组 {group.group_id} 的允许层 {idx} 不是 signal 层")
    return group.allowed_layers


def can_hop(layer_a: int, layer_b: int, stack: LayerStack | None) -> bool:
    """通孔 → 全栈互连；盲埋微孔按 span（预留）。"""
    if stack is None or stack.via_kind == "through":
        return True
    return layer_a == layer_b


def split_trace_plane(nets: tuple[Net, ...],
                      cfg: LayeringConfig) -> tuple[tuple[Net, ...], tuple[Net, ...]]:
    """将走线 net 与 plane net（电源/地）分开。"""
    if not cfg.plane_nets_excluded:
        return nets, ()
    trace: list[Net] = []
    plane: list[Net] = []
    for n in nets:
        if n.net_class in (NetClass.POWER, NetClass.GROUND):
            plane.append(n)
        else:
            trace.append(n)
    return tuple(trace), tuple(plane)


def group_wires_by_signal_group(wires: tuple[Wire, ...],
                                nets: tuple[Net, ...]) -> dict[str | None, list[Wire]]:
    net_to_group = {n.net_id: n.signal_group_id for n in nets}
    groups: dict[str | None, list[Wire]] = {}
    for w in wires:
        groups.setdefault(net_to_group.get(w.net_id), []).append(w)
    return groups


def wire_allowed_layers(w: Wire, nets: tuple[Net, ...],
                        groups: tuple[SignalGroup, ...],
                        stack: LayerStack | None) -> set[int]:
    """某 wire 的允许层集合（由其所属信号组决定）。"""
    net = next((n for n in nets if n.net_id == w.net_id), None)
    gid = net.signal_group_id if net else None
    for g in groups:
        if g.group_id == gid:
            return set(allowed_layers_of(g, stack))
    # 未归组 → 全部 signal 层
    return set(signal_layers(stack))
