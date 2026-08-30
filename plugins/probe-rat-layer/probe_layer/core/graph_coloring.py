"""DSATUR 着色（方法 A：对比基线，支持受限着色）。"""
from __future__ import annotations

from ..model import ConflictGraph


class UncolorableError(RuntimeError):
    pass


def dsatur_color(graph: ConflictGraph,
                 max_layers: int | None = None,
                 allowed: dict[str, set[int]] | None = None,
                 initial: dict[str, int] | None = None) -> dict[str, int]:
    """DSATUR 变体。

    allowed: wire_id -> 允许的层集合（受限着色）；None 表示任意层。
    initial: 预着色（增量修复时冻结的线）。
    """
    colors: dict[str, int] = dict(initial or {})
    uncolored = set(graph.nodes()) - set(colors.keys())

    while uncolored:
        best: str | None = None
        best_sat = -1
        best_deg = -1
        for n in uncolored:
            sat = len({colors[m] for m in graph.neighbors(n) if m in colors})
            deg = len(graph.neighbors(n))
            if sat > best_sat or (sat == best_sat and deg > best_deg):
                best_sat, best_deg, best = sat, deg, n

        used = {colors[m] for m in graph.neighbors(best) if m in colors}
        domain = allowed.get(best) if allowed else None
        if domain is not None:
            avail = sorted(domain - used)
            if not avail:
                raise UncolorableError(f"节点 {best} 无可用层（允许 {sorted(domain)}，邻用 {sorted(used)}）")
            colors[best] = avail[0]
        else:
            c = 0
            while c in used:
                c += 1
            colors[best] = c
        uncolored.remove(best)

    if max_layers is not None:
        used_max = max(colors.values(), default=0) + 1
        if used_max > max_layers:
            raise UncolorableError(f"着色需要 {used_max} 层，超过 max_layers={max_layers}")
    return colors


def minimize_layers(assignment: dict[str, int]) -> int:
    return (max(assignment.values()) + 1) if assignment else 0
