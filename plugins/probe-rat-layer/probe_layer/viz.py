"""可视化（matplotlib，输出 PNG + SVG）。"""
from __future__ import annotations

import hashlib
import math
import os
from collections import Counter

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches

from .model import (LayeringResult, LayerInfo, Wire, KeepoutZone, RectZone,
                    CircleZone, Conflict, ConflictLevel)
from .core import congestion
from .core import metrics
from .core.layer_packing import wire_dir_angle
from .config import LayeringConfig


def _color(net_id: str) -> str:
    h = int(hashlib.md5(net_id.encode()).hexdigest()[:6], 16)
    return f"#{(h & 0xFFFFFF):06x}"


def _bbox(wire_by_id: dict[str, Wire], zones: tuple[KeepoutZone, ...]) -> tuple[float, float, float, float]:
    xs: list[float] = []
    ys: list[float] = []
    for w in wire_by_id.values():
        xs += [w.start.x, w.end.x]
        ys += [w.start.y, w.end.y]
    for z in zones:
        if isinstance(z, RectZone):
            xs += [z.xmin, z.xmax]
            ys += [z.ymin, z.ymax]
        else:
            xs += [z.center.x - z.radius, z.center.x + z.radius]
            ys += [z.center.y - z.radius, z.center.y + z.radius]
    if not xs:
        return (0.0, 1.0, 0.0, 1.0)
    pad = max(max(xs) - min(xs), max(ys) - min(ys), 1.0) * 0.05
    return (min(xs) - pad, max(xs) + pad, min(ys) - pad, max(ys) + pad)


def _draw_keepouts(ax, zones: tuple[KeepoutZone, ...]) -> None:
    for z in zones:
        if isinstance(z, RectZone):
            ax.add_patch(mpatches.Rectangle(
                (z.xmin, z.ymin), z.xmax - z.xmin, z.ymax - z.ymin,
                facecolor="0.85", edgecolor="red", hatch="///", alpha=0.6))
        else:
            ax.add_patch(mpatches.Circle(
                (z.center.x, z.center.y), z.radius,
                facecolor="0.85", edgecolor="red", hatch="///", alpha=0.6))


def _save(fig, base: str) -> None:
    fig.tight_layout()
    fig.savefig(base + ".png", dpi=120)
    fig.savefig(base + ".svg")
    plt.close(fig)


def render_layer(layer: LayerInfo, wire_by_id: dict[str, Wire],
                 zones: tuple[KeepoutZone, ...], conflicts: tuple[Conflict, ...],
                 out_dir: str) -> str:
    fig, ax = plt.subplots(figsize=(10, 8))
    _draw_keepouts(ax, zones)

    layer_wires = set(layer.wires)
    for wid in layer.wires:
        w = wire_by_id[wid]
        ax.plot([w.start.x, w.end.x], [w.start.y, w.end.y],
                color=_color(w.net_id), lw=1.5)

    for c in conflicts:
        if c.intersect_pt is None:
            continue
        if c.wire_a in layer_wires and c.wire_b in layer_wires:
            if c.level == ConflictLevel.HARD:
                ax.plot(c.intersect_pt.x, c.intersect_pt.y, "rx", markersize=10, mew=2)
            elif c.level == ConflictLevel.SOFT:
                ax.plot(c.intersect_pt.x, c.intersect_pt.y, "o",
                        mfc="orange", mec="k", markersize=8)

    ax.set_aspect("equal")
    xmin, xmax, ymin, ymax = _bbox(wire_by_id, zones)
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)
    ax.set_title(f"Layer {layer.layer_index} ({layer.kind}) — {len(layer.wires)} wires")
    ax.grid(alpha=0.2)
    img_dir = os.path.join(out_dir, "img")
    os.makedirs(img_dir, exist_ok=True)
    base = os.path.join(img_dir, f"layer_{layer.layer_index:02d}")
    _save(fig, base)
    return base


def render_overview(result: LayeringResult, wire_by_id: dict[str, Wire],
                    zones: tuple[KeepoutZone, ...], out_dir: str) -> str:
    fig, ax = plt.subplots(figsize=(10, 8))
    _draw_keepouts(ax, zones)
    cmap = plt.get_cmap("tab10")
    styles = ["-", "--", "-.", ":"]
    for li in result.layers:
        if li.kind == "plane":
            continue
        color = cmap((li.layer_index - 1) % 10)
        ls = styles[(li.layer_index - 1) % len(styles)]
        for wid in li.wires:
            w = wire_by_id[wid]
            ax.plot([w.start.x, w.end.x], [w.start.y, w.end.y],
                    color=color, ls=ls, lw=1.2)
    ax.set_aspect("equal")
    xmin, xmax, ymin, ymax = _bbox(wire_by_id, zones)
    ax.set_xlim(xmin, xmax)
    ax.set_ylim(ymin, ymax)
    ax.set_title("Overview (line style = layer)")
    ax.grid(alpha=0.2)
    img_dir = os.path.join(out_dir, "img")
    os.makedirs(img_dir, exist_ok=True)
    base = os.path.join(img_dir, "overview")
    _save(fig, base)
    return base


def render_congestion(cmap: congestion.CongestionMap, out_dir: str, layer: int) -> str:
    fig, ax = plt.subplots(figsize=(8, 6))
    im = ax.imshow(cmap.occupancy, origin="lower", cmap="RdYlGn_r", vmin=0.0, vmax=1.0,
                   extent=[cmap.origin[0], cmap.origin[0] + cmap.width * cmap.cell,
                           cmap.origin[1], cmap.origin[1] + cmap.height * cmap.cell])
    fig.colorbar(im, ax=ax, label="occupancy")
    ax.set_title(f"Congestion layer {layer}")
    ax.set_aspect("equal")
    img_dir = os.path.join(out_dir, "img")
    os.makedirs(img_dir, exist_ok=True)
    base = os.path.join(img_dir, f"congestion_{layer:02d}")
    _save(fig, base)
    return base


def render_rose(result: LayeringResult, wire_by_id: dict[str, Wire],
                out_dir: str, cfg: LayeringConfig) -> str:
    """每层的方向玫瑰图：按外 pin 极角扇区统计线数（极坐标柱状图）。

    圆形针卡径向走线，这张图直接显示每层覆盖了哪些扇区、覆盖是否均匀。
    """
    sig = [li for li in result.layers if li.kind == "signal"]
    if not sig:
        return ""
    nsect = max(1, int(round(360.0 / cfg.sector_angle_deg)))
    fig, axes = plt.subplots(1, len(sig), subplot_kw={"projection": "polar"},
                             figsize=(4.2 * len(sig), 4.0), squeeze=False)
    for ax, li in zip(axes.flat, sig):
        counts = Counter()
        for wid in li.wires:
            w = wire_by_id[wid]
            counts[metrics.sector_index(wire_dir_angle(w), cfg.sector_angle_deg)] += 1
        theta = [2 * math.pi * s / nsect for s in range(nsect)]
        width = 2 * math.pi / nsect
        heights = [counts.get(s, 0) for s in range(nsect)]
        ax.bar(theta, heights, width=width, bottom=0.0, alpha=0.7)
        ax.set_title(f"Layer {li.layer_index} ({len(li.wires)})", fontsize=11)
        ax.set_theta_zero_location("E")   # 0° = +x（与 atan2 一致）
        ax.set_theta_direction(1)         # 逆时针
    fig.suptitle("Direction rose by layer (outer-pin polar angle)", fontsize=12)
    img_dir = os.path.join(out_dir, "img")
    os.makedirs(img_dir, exist_ok=True)
    base = os.path.join(img_dir, "rose")
    _save(fig, base)
    return base


def render_all(result: LayeringResult, wire_by_id: dict[str, Wire],
               zones: tuple[KeepoutZone, ...], out_dir: str, cfg: LayeringConfig) -> tuple[str, ...]:
    os.makedirs(out_dir, exist_ok=True)
    conflicts = result.hard_conflicts + result.soft_conflicts
    produced: list[str] = []
    for li in result.layers:
        if li.kind == "plane":
            continue
        produced.append(render_layer(li, wire_by_id, zones, conflicts, out_dir))
        if cfg.render_congestion:
            layer_wires = tuple(wire_by_id[w] for w in li.wires if w in wire_by_id)
            pins: tuple = ()
            cmap = congestion.build_congestion_map(layer_wires, zones, pins, cfg)
            produced.append(render_congestion(cmap, out_dir, li.layer_index))
    produced.append(render_overview(result, wire_by_id, zones, out_dir))
    produced.append(render_rose(result, wire_by_id, out_dir, cfg))
    return tuple(produced)
