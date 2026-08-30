"""禁布区加载、膨胀、线段相交、咽喉检测（基于 shapely）。"""
from __future__ import annotations

from ..model import Point, RectZone, CircleZone, KeepoutZone, Wire
from ..config import LayeringConfig
from . import geometry as geo


def load_keepouts(specs: list[dict]) -> tuple[KeepoutZone, ...]:
    zones: list[KeepoutZone] = []
    for s in specs:
        shape = s.get("shape")
        if shape == "rect":
            zones.append(RectZone(s["zone_id"], float(s["xmin"]), float(s["ymin"]),
                                  float(s["xmax"]), float(s["ymax"])))
        elif shape == "circle":
            c = s["center"]
            zones.append(CircleZone(s["zone_id"], Point(float(c["x"]), float(c["y"])),
                                    float(s["radius"])))
        else:
            raise ValueError(f"未知禁布区形状: {shape!r}")
    return tuple(zones)


def zones_crossed_by(w: Wire, zones: tuple[KeepoutZone, ...],
                     margin: float = 0.0) -> tuple[str, ...]:
    line = geo.wire_line(w)
    return tuple(z.zone_id for z in zones
                 if line.intersects(geo.zone_geom(z).buffer(margin) if margin > 0
                                    else geo.zone_geom(z)))


def both_cross_same_zone(wa: Wire, wb: Wire,
                         zones: tuple[KeepoutZone, ...]) -> tuple[str, ...]:
    a = set(zones_crossed_by(wa, zones))
    b = set(zones_crossed_by(wb, zones))
    return tuple(sorted(a & b))


def in_zone_overlap_length(wa: Wire, wb: Wire, zone: KeepoutZone) -> float:
    return geo.in_zone_overlap_length(wa, wb, zone)


def pinch_zones(wires: tuple[Wire, ...], zones: tuple[KeepoutZone, ...],
                cfg: LayeringConfig) -> tuple[str, ...]:
    """咽喉检测：多条线挤过同一禁布区且区窄（不足以并排通过）→ 咽喉。

    bottleneck 近似 = 穿越线所需通道宽 / 区窄边宽，> 1 视为咽喉（占位启发式，待反标定）。
    """
    out: list[str] = []
    for z in zones:
        crossing = [w for w in wires if geo.wire_line(w).intersects(geo.zone_geom(z))]
        if len(crossing) < 2:
            continue
        if isinstance(z, RectZone):
            narrow = min(z.xmax - z.xmin, z.ymax - z.ymin)
        else:
            narrow = 2.0 * z.radius
        needed = sum(w.width + w.clearance for w in crossing)
        if narrow > 0 and needed / narrow > 1.0:
            out.append(z.zone_id)
    return tuple(out)
