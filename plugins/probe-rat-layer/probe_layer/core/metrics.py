"""分层质量指标：软冲突 + 数量/长短/扇区均衡。

所有指标都是"越小越好"。扇区均衡只统计**实际有线经过**的扇区：
圆形针卡测试机端不满配，部分角度没有外围连线，空扇区不应被惩罚。
圆心固定为 (0,0)（用户确认）。
"""
from __future__ import annotations

from collections import Counter


def sector_index(angle_deg: float, sector_angle_deg: float) -> int:
    """极角 [0,360) → 扇区号 [0, n)。n = round(360 / sector_angle_deg)。"""
    n = max(1, int(round(360.0 / sector_angle_deg)))
    return int(angle_deg // sector_angle_deg) % n


def soft_crossings(assignment: dict[str, int],
                   soft_pairs: list[tuple[str, str]]) -> int:
    """同层软冲突（交叉）对数。只统计两端都已分配的线对。"""
    total = 0
    for a, b in soft_pairs:
        la, lb = assignment.get(a), assignment.get(b)
        if la is not None and la == lb:
            total += 1
    return total


def count_imbalance(layer_counts: dict[int, int]) -> float:
    """各层线数不均衡度 = (max - min) / mean，0 表示完全均衡。

    空层（0 线）也算一层：全堆在一层时是不均衡的。
    """
    vals = list(layer_counts.values())
    if len(vals) < 2:
        return 0.0
    mean = sum(vals) / len(vals)
    if mean <= 0:
        return 0.0
    return (max(vals) - min(vals)) / mean


def length_imbalance(layer_lengths: dict[int, float],
                     layer_counts: dict[int, int]) -> float:
    """各层平均线长不均衡度 = (max_avg - min_avg) / mean_avg。

    空层平均线长按 0 计（一个空层即失衡）。
    """
    avgs = [layer_lengths[l] / c if c > 0 else 0.0
            for l, c in layer_counts.items()]
    if len(avgs) < 2:
        return 0.0
    mean = sum(avgs) / len(avgs)
    if mean <= 0:
        return 0.0
    return (max(avgs) - min(avgs)) / mean


def sector_imbalance(layer_sectors: dict[int, Counter], total_wires: int) -> float:
    """各层扇区覆盖不均衡度，只统计实际有线经过的扇区。

    对每个"有线的扇区" s，取它落在各层的线数 c_s 的 (max-min) 求和，
    再除以总线数归一化到 [0,1) 附近。空扇区不参与，避免无意义惩罚。
    """
    populated: set[int] = set()
    for c in layer_sectors.values():
        populated.update(c.keys())
    if not populated or total_wires <= 0:
        return 0.0
    imbalance = 0.0
    for s in populated:
        vals = [layer_sectors[l].get(s, 0) for l in layer_sectors]
        imbalance += max(vals) - min(vals)
    return imbalance / total_wires
