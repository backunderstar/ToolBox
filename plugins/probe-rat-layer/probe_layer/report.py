"""JSON 报告 + 文本摘要 + 层→net 导出。"""
from __future__ import annotations

import csv
import datetime
import json
import os

from .model import LayeringResult, Conflict
from .config import LayeringConfig
from . import __version__


def _conflict_dict(c: Conflict) -> dict:
    return {
        "wire_a": c.wire_a,
        "wire_b": c.wire_b,
        "level": c.level.value,
        "intersect_pt": {"x": c.intersect_pt.x, "y": c.intersect_pt.y} if c.intersect_pt else None,
        "clearance_gap": round(c.clearance_gap, 6),
        "dist_to_endpoints": [round(x, 6) for x in c.dist_to_endpoints],
        "keepout_ids": list(c.keepout_ids),
        "congestion": round(c.congestion, 4),
        "reasons": list(c.reasons),
    }


def build_report(result: LayeringResult, cfg: LayeringConfig) -> dict:
    layer_count = len(result.layers)
    return {
        "meta": {
            "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
            "algorithm_version": __version__,
        },
        "config": cfg.to_dict(),
        "summary": {
            "method": result.method,
            "layer_count": layer_count,
            "wire_assigned_count": len(result.assignment),
            "plane_net_count": len(result.plane_nets),
            "capacity_lower_bound": result.capacity_lower_bound,
            "iterations_used": result.iterations_used,
            "hard_conflict_count": len(result.hard_conflicts),
            "soft_conflict_count": len(result.soft_conflicts),
            "manual_route_net_count": len(result.manual_route_nets),
            "manual_route_nets": list(result.manual_route_nets),
            "warnings": list(result.warnings),
        },
        "plane_nets": list(result.plane_nets),
        "layers": [
            {
                "layer": li.layer_index,
                "kind": li.kind,
                "signal_groups": list(li.signal_groups),
                "nets": list(li.nets),
                "wires": list(li.wires),
                "soft_conflict_count": li.soft_conflict_count,
                "max_occupancy": li.max_occupancy,
                "requires_detour": list(li.requires_detour),
                "requires_endpoint_via": list(li.requires_endpoint_via),
            }
            for li in result.layers
        ],
        "conflicts": {
            "hard": [_conflict_dict(c) for c in result.hard_conflicts],
            "soft": [_conflict_dict(c) for c in result.soft_conflicts],
        },
    }


def write_report(report: dict, out_dir: str) -> str:
    json_dir = os.path.join(out_dir, "json")
    os.makedirs(json_dir, exist_ok=True)
    path = os.path.join(json_dir, "report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    return path


def export_layer_nets(result: LayeringResult, out_dir: str) -> str:
    json_dir = os.path.join(out_dir, "json")
    os.makedirs(json_dir, exist_ok=True)
    payload = {
        "units": "mm",
        "layers": [
            {"layer": li.layer_index, "kind": li.kind, "nets": list(li.nets)}
            for li in result.layers
        ],
    }
    path = os.path.join(json_dir, "layer_nets.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


def export_layer_nets_lst(result: LayeringResult, out_dir: str) -> str:
    """每层写一个 layer_<i>.lst：一行一个 net，无标点，供 Allegro 直接导入。"""
    lst_dir = os.path.join(out_dir, "lst")
    os.makedirs(lst_dir, exist_ok=True)
    paths = []
    for li in result.layers:
        if li.kind != "signal":
            continue
        path = os.path.join(lst_dir, f"layer_{li.layer_index}.lst")
        with open(path, "w", encoding="ascii") as f:
            f.write("\n".join(li.nets))
            if li.nets:
                f.write("\n")
        paths.append(path)
    return ", ".join(paths)


def export_manual_route_lst(result: LayeringResult, out_dir: str) -> str:
    """需人工 route 的 net（同层硬冲突无法自动分层）→ manual_route.lst。"""
    lst_dir = os.path.join(out_dir, "lst")
    os.makedirs(lst_dir, exist_ok=True)
    path = os.path.join(lst_dir, "manual_route.lst")
    with open(path, "w", encoding="ascii") as f:
        f.write("\n".join(result.manual_route_nets))
        if result.manual_route_nets:
            f.write("\n")
    return path


def export_net_layer_csv(result: LayeringResult, out_dir: str) -> str:
    """net_name, layer 的 CSV（多线 net 若跨层会出现多行）。"""
    csv_dir = os.path.join(out_dir, "csv")
    os.makedirs(csv_dir, exist_ok=True)
    path = os.path.join(csv_dir, "net_layer_assignment.csv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["net_name", "layer"])
        for li in result.layers:
            if li.kind != "signal":
                continue
            for net in li.nets:
                w.writerow([net, li.layer_index])
    return path


def export_layer_statistics_csv(result: LayeringResult, out_dir: str) -> str:
    """每层 net 数 / 线数 / 软冲突 / 占用率 的 CSV。"""
    csv_dir = os.path.join(out_dir, "csv")
    os.makedirs(csv_dir, exist_ok=True)
    path = os.path.join(csv_dir, "layer_statistics.csv")
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["layer", "kind", "net_count", "wire_count",
                    "soft_conflicts", "max_occupancy"])
        for li in result.layers:
            w.writerow([li.layer_index, li.kind, len(li.nets), len(li.wires),
                        li.soft_conflict_count, li.max_occupancy])
    return path


def print_summary(result: LayeringResult) -> str:
    lines = ["== 探针卡飞线分层结果 ==",
             f"方法 {result.method} / 迭代 {result.iterations_used} 轮 / "
             f"层数 {len(result.layers)}",
             f"已分配线 {len(result.assignment)} / 硬冲突 {len(result.hard_conflicts)} / "
             f"软冲突 {len(result.soft_conflicts)}",
             f"平面网: {', '.join(result.plane_nets) if result.plane_nets else '(无)'}"]
    if result.manual_route_nets:
        lines.append(f"需人工 route: {len(result.manual_route_nets)} 条（manual_route.lst）")
    if result.capacity_lower_bound:
        lb = ", ".join(f"{k}={v}" for k, v in result.capacity_lower_bound.items())
        lines.append(f"容量下界（最少层数）: {lb}")
    for li in result.layers:
        extra = []
        if li.soft_conflict_count:
            extra.append(f"软冲突 {li.soft_conflict_count}")
        if li.max_occupancy:
            extra.append(f"占用率 {li.max_occupancy:.2f}")
        if li.requires_detour:
            extra.append(f"绕行 {','.join(li.requires_detour)}")
        if li.requires_endpoint_via:
            extra.append(f"端点过孔 {','.join(li.requires_endpoint_via)}")
        suffix = (" | " + " | ".join(extra)) if extra else ""
        lines.append(f"  层 {li.layer_index} ({li.kind}): {len(li.wires)} 线{suffix}")
    if result.warnings:
        lines.append("警告:")
        lines.extend(f"  - {w}" for w in result.warnings)
    return "\n".join(lines)
