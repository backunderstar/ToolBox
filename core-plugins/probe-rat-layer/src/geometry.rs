//! 纯几何基础库（自写，逐位对齐 Python `shapely` 语义；替代 shapely，避免依赖漂移）。
//!
//! 提供线段相交/距离、点段距、矩形/圆包含、线段在 zone 内子段长度等 2D 原语。

use crate::model::{CircleZone, KeepoutZone, Point, RectZone, Wire};

pub const EPS: f64 = 1e-9;

pub fn seg_len(a: Point, b: Point) -> f64 {
    a.dist(b)
}

/// 线段与线段的严格交点：平行/共线返回 None；相交（含端点接触）返回交点。
pub fn seg_seg_intersection(a1: Point, a2: Point, b1: Point, b2: Point) -> Option<Point> {
    let d1x = a2.x - a1.x;
    let d1y = a2.y - a1.y;
    let d2x = b2.x - b1.x;
    let d2y = b2.y - b1.y;
    let denom = d1x * d2y - d1y * d2x;
    if denom.abs() < EPS {
        return None; // 平行
    }
    let t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
    let u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
    if (-EPS..=1.0 + EPS).contains(&t) && (-EPS..=1.0 + EPS).contains(&u) {
        Some(Point::new(a1.x + t * d1x, a1.y + t * d1y))
    } else {
        None
    }
}

/// 点到线段的距离。
pub fn point_seg_distance(p: Point, a: Point, b: Point) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let l2 = dx * dx + dy * dy;
    if l2 <= EPS * EPS {
        return a.dist(p);
    }
    let t = (((p.x - a.x) * dx + (p.y - a.y) * dy) / l2).clamp(0.0, 1.0);
    let proj = Point::new(a.x + t * dx, a.y + t * dy);
    p.dist(proj)
}

/// 两线段最小距离（相交为 0）。
pub fn seg_seg_min_distance(a1: Point, a2: Point, b1: Point, b2: Point) -> f64 {
    if seg_seg_intersection(a1, a2, b1, b2).is_some() {
        return 0.0;
    }
    let d = point_seg_distance(a1, b1, b2)
        .min(point_seg_distance(a2, b1, b2))
        .min(point_seg_distance(b1, a1, a2))
        .min(point_seg_distance(b2, a1, a2));
    d
}

/// 线膨胀半径 = 线宽/2 + 间距/2。
pub fn expansion_radius(w: &Wire) -> f64 {
    w.width / 2.0 + w.clearance / 2.0
}

/// 两线最小允许间距（含线宽膨胀）。
pub fn min_allowed_distance(wa: &Wire, wb: &Wire) -> f64 {
    expansion_radius(wa) + expansion_radius(wb)
}

/// 规则间距 - 实际间距（含线宽膨胀）；>0 表示间距不足。
pub fn clearance_gap(wa: &Wire, wb: &Wire, d: f64) -> f64 {
    min_allowed_distance(wa, wb) - d
}

// ---------------------------------------------------------------------------
// 禁布区几何帮助
// ---------------------------------------------------------------------------

fn rect_contains(r: &RectZone, p: Point) -> bool {
    p.x >= r.xmin - EPS && p.x <= r.xmax + EPS && p.y >= r.ymin - EPS && p.y <= r.ymax + EPS
}

fn circle_contains(c: &CircleZone, p: Point) -> bool {
    p.dist(c.center) <= c.radius + EPS
}

pub fn point_in_zone(p: Point, zone: &KeepoutZone) -> bool {
    match zone {
        KeepoutZone::Rect(z) => rect_contains(z, p),
        KeepoutZone::Circle(z) => circle_contains(z, p),
    }
}

/// 线段在矩形内的子段长度（Liang-Barsky 裁剪）。
pub(crate) fn seg_in_rect_length(a: Point, b: Point, r: &RectZone) -> f64 {
    let mut t0 = 0.0f64;
    let mut t1 = 1.0f64;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let p = [-dx, dx, -dy, dy];
    let q = [a.x - r.xmin, r.xmax - a.x, a.y - r.ymin, r.ymax - a.y];
    for i in 0..4 {
        if p[i].abs() < EPS {
            if q[i] < 0.0 {
                return 0.0;
            }
        } else {
            let t = q[i] / p[i];
            if p[i] < 0.0 {
                if t > t1 {
                    return 0.0;
                }
                if t > t0 {
                    t0 = t;
                }
            } else {
                if t < t0 {
                    return 0.0;
                }
                if t < t1 {
                    t1 = t;
                }
            }
        }
    }
    seg_len(Point::new(a.x + t0 * dx, a.y + t0 * dy), Point::new(a.x + t1 * dx, a.y + t1 * dy))
}

/// 线段在圆内的子段长度（解析求圆与直线交点，再夹到线段范围）。
pub(crate) fn seg_in_circle_length(a: Point, b: Point, c: &CircleZone) -> f64 {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let fx = a.x - c.center.x;
    let fy = a.y - c.center.y;
    let a2 = dx * dx + dy * dy;
    let r2 = c.radius * c.radius;
    if a2 <= EPS * EPS {
        return if circle_contains(c, a) { 0.0 } else { 0.0 };
    }
    let b2 = 2.0 * (fx * dx + fy * dy);
    let c2 = fx * fx + fy * fy - r2;
    let disc = b2 * b2 - 4.0 * a2 * c2;
    if disc < 0.0 {
        return 0.0;
    }
    let sq = disc.sqrt();
    let t1 = (-b2 - sq) / (2.0 * a2);
    let t2 = (-b2 + sq) / (2.0 * a2);
    let lo = t1.max(0.0);
    let hi = t2.min(1.0);
    if hi <= lo {
        return 0.0;
    }
    seg_len(Point::new(a.x + lo * dx, a.y + lo * dy), Point::new(a.x + hi * dx, a.y + hi * dy))
}

pub fn seg_in_zone_length(a: Point, b: Point, zone: &KeepoutZone) -> f64 {
    match zone {
        KeepoutZone::Rect(z) => seg_in_rect_length(a, b, z),
        KeepoutZone::Circle(z) => seg_in_circle_length(a, b, z),
    }
}

/// 两线在禁布区内子段间距不足时返回正的"重叠长度"代理，否则 0。
pub fn in_zone_overlap_length(wa: &Wire, wb: &Wire, zone: &KeepoutZone) -> f64 {
    let za = seg_in_zone_length(wa.start, wa.end, zone);
    let zb = seg_in_zone_length(wb.start, wb.end, zone);
    if za <= EPS || zb <= EPS {
        return 0.0;
    }
    // 用两线在 zone 内的子段最小距离判断是否需绕行
    let d = zone_seg_min_distance(wa.start, wa.end, wb.start, wb.end, zone);
    if d < min_allowed_distance(wa, wb) {
        za.min(zb)
    } else {
        0.0
    }
}

/// 两线段在 zone 内裁剪后的最小距离（用于 overlap 判断）。
fn zone_seg_min_distance(a1: Point, a2: Point, b1: Point, b2: Point, zone: &KeepoutZone) -> f64 {
    match zone {
        KeepoutZone::Rect(z) => {
            let c1 = clip_seg_rect(a1, a2, z);
            let c2 = clip_seg_rect(b1, b2, z);
            match (c1, c2) {
                (Some((p1, p2)), Some((q1, q2))) => seg_seg_min_distance(p1, p2, q1, q2),
                _ => f64::INFINITY,
            }
        }
        KeepoutZone::Circle(z) => {
            let c1 = clip_seg_circle(a1, a2, z);
            let c2 = clip_seg_circle(b1, b2, z);
            match (c1, c2) {
                (Some((p1, p2)), Some((q1, q2))) => seg_seg_min_distance(p1, p2, q1, q2),
                _ => f64::INFINITY,
            }
        }
    }
}

fn clip_seg_rect(a: Point, b: Point, r: &RectZone) -> Option<(Point, Point)> {
    let mut t0 = 0.0f64;
    let mut t1 = 1.0f64;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let p = [-dx, dx, -dy, dy];
    let q = [a.x - r.xmin, r.xmax - a.x, a.y - r.ymin, r.ymax - a.y];
    for i in 0..4 {
        if p[i].abs() < EPS {
            if q[i] < 0.0 {
                return None;
            }
        } else {
            let t = q[i] / p[i];
            if p[i] < 0.0 {
                if t > t1 {
                    return None;
                }
                if t > t0 {
                    t0 = t;
                }
            } else {
                if t < t0 {
                    return None;
                }
                if t < t1 {
                    t1 = t;
                }
            }
        }
    }
    Some((
        Point::new(a.x + t0 * dx, a.y + t0 * dy),
        Point::new(a.x + t1 * dx, a.y + t1 * dy),
    ))
}

fn clip_seg_circle(a: Point, b: Point, c: &CircleZone) -> Option<(Point, Point)> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let fx = a.x - c.center.x;
    let fy = a.y - c.center.y;
    let a2 = dx * dx + dy * dy;
    let r2 = c.radius * c.radius;
    if a2 <= EPS * EPS {
        return if circle_contains(c, a) { Some((a, a)) } else { None };
    }
    let b2 = 2.0 * (fx * dx + fy * dy);
    let c2 = fx * fx + fy * fy - r2;
    let disc = b2 * b2 - 4.0 * a2 * c2;
    if disc < 0.0 {
        return None;
    }
    let sq = disc.sqrt();
    let t1 = (-b2 - sq) / (2.0 * a2);
    let t2 = (-b2 + sq) / (2.0 * a2);
    let lo = t1.max(0.0);
    let hi = t2.min(1.0);
    if hi < lo - EPS {
        return None;
    }
    Some((
        Point::new(a.x + lo * dx, a.y + lo * dy),
        Point::new(a.x + hi.min(1.0) * dx, a.y + hi.min(1.0) * dy),
    ))
}

pub fn bboxes_overlap(wa: &Wire, wb: &Wire, margin: f64) -> bool {
    let a = wa.bounding_box();
    let b = wb.bounding_box();
    !(a.2 + margin < b.0 || b.2 + margin < a.0 || a.3 + margin < b.1 || b.3 + margin < a.1)
}
