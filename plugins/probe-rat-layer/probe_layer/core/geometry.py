"""纯几何基础库（基于 shapely）。"""
from __future__ import annotations

from shapely.geometry import LineString, Point as SPoint, box
from shapely.geometry.base import BaseGeometry

from ..model import Point, RectZone, CircleZone, KeepoutZone, Wire

EPS = 1e-9


def to_spoint(p: Point) -> SPoint:
    return SPoint(p.x, p.y)


def line_of(a: Point, b: Point) -> LineString:
    return LineString([(a.x, a.y), (b.x, b.y)])


def wire_line(w: Wire) -> LineString:
    return line_of(w.start, w.end)


def zone_geom(z: KeepoutZone) -> BaseGeometry:
    """禁布区 → shapely 几何（矩形 box / 圆形 buffer）。"""
    if isinstance(z, RectZone):
        return box(z.xmin, z.ymin, z.xmax, z.ymax)
    return to_spoint(z.center).buffer(z.radius)


def seg_seg_intersection(a1: Point, a2: Point, b1: Point, b2: Point) -> Point | None:
    """严格相交返回交点；平行/共线返回 None。"""
    g = line_of(a1, a2).intersection(line_of(b1, b2))
    if g.is_empty or g.geom_type != "Point":
        return None
    return Point(g.x, g.y)


def point_seg_distance(p: Point, a: Point, b: Point) -> float:
    return to_spoint(p).distance(line_of(a, b))


def seg_seg_min_distance(a1: Point, a2: Point, b1: Point, b2: Point) -> float:
    return line_of(a1, a2).distance(line_of(b1, b2))


def expansion_radius(w: Wire) -> float:
    """线膨胀半径 = 线宽/2 + 间距/2。"""
    return w.width / 2.0 + w.clearance / 2.0


def min_allowed_distance(wa: Wire, wb: Wire) -> float:
    return expansion_radius(wa) + expansion_radius(wb)


def clearance_gap(wa: Wire, wb: Wire, d: float) -> float:
    """规则间距 - 实际间距（含线宽膨胀）；>0 表示间距不足。"""
    return min_allowed_distance(wa, wb) - d


def seg_in_zone_length(a: Point, b: Point, zone: KeepoutZone) -> float:
    g = line_of(a, b).intersection(zone_geom(zone))
    return g.length if not g.is_empty else 0.0


def in_zone_overlap_length(wa: Wire, wb: Wire, zone: KeepoutZone) -> float:
    """两线在禁布区内子段间距不足时返回正的"重叠长度"代理，否则 0。"""
    za = wire_line(wa).intersection(zone_geom(zone))
    zb = wire_line(wb).intersection(zone_geom(zone))
    if za.is_empty or zb.is_empty:
        return 0.0
    if za.distance(zb) < min_allowed_distance(wa, wb):
        return za.length
    return 0.0


def point_in_zone(p: Point, zone: KeepoutZone) -> bool:
    return zone_geom(zone).covers(to_spoint(p))


def bboxes_overlap(wa: Wire, wb: Wire, margin: float = 0.0) -> bool:
    a = wa.bounding_box
    b = wb.bounding_box
    return not (a[2] + margin < b[0] or b[2] + margin < a[0] or
                a[3] + margin < b[1] or b[3] + margin < a[1])
