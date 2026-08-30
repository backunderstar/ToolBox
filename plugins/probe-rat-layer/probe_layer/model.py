"""核心数据模型。

单位统一为 mm（内部计算）。除 ConflictGraph / LayeringResult 外均为 frozen dataclass。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


@dataclass(frozen=True)
class Point:
    x: float
    y: float

    def __sub__(self, other: "Point") -> "Point":
        return Point(self.x - other.x, self.y - other.y)

    def __add__(self, other: "Point") -> "Point":
        return Point(self.x + other.x, self.y + other.y)

    def dist(self, other: "Point") -> float:
        return math.hypot(self.x - other.x, self.y - other.y)


class Units(str, Enum):
    MM = "mm"
    MIL = "mil"
    UM = "um"


# ---------------------------------------------------------------------------
# 层叠 / 信号组 / 网络组
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LayerDef:
    index: int                       # 1-based 层序号
    name: str
    kind: str = "signal"             # "signal" | "plane"
    preferred_dir: str = "any"       # "H" | "V" | "any" | "-"


@dataclass(frozen=True)
class LayerStack:
    layers: tuple[LayerDef, ...]
    via_kind: str = "through"        # 本设计：通孔（全栈互连）

    def signal_layers(self) -> tuple[int, ...]:
        return tuple(l.index for l in self.layers if l.kind == "signal")

    def plane_layers(self) -> tuple[int, ...]:
        return tuple(l.index for l in self.layers if l.kind == "plane")

    def kind_of(self, index: int) -> str:
        for l in self.layers:
            if l.index == index:
                return l.kind
        return "signal"

    def layer_names(self) -> dict[int, str]:
        return {l.index: l.name for l in self.layers}


@dataclass(frozen=True)
class SignalGroup:
    group_id: str
    allowed_layers: tuple[int, ...]  # 该组可走线的层索引（如 (1, 3, 4)）
    net_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class NetGroup:
    """差分对/等长组等同层约束组（预留接口）。"""
    group_id: str
    kind: str                        # "diff_pair" | "matched_length" | ...
    net_ids: tuple[str, ...] = ()
    same_layer: bool = True


class NetClass(str, Enum):
    SIGNAL = "signal"
    POWER = "power"
    GROUND = "ground"


# ---------------------------------------------------------------------------
# 网络 / 飞线
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Pin:
    pin_id: str
    pos: Point


@dataclass(frozen=True)
class Net:
    net_id: str
    net_class: NetClass = NetClass.SIGNAL
    signal_group_id: Optional[str] = None
    net_group_id: Optional[str] = None
    pins: tuple[Pin, ...] = ()
    width: float = 0.05              # 线宽 mm
    clearance: float = 0.05          # 间距规则 mm


@dataclass(frozen=True)
class Wire:
    """一条 ratsnest 连接边（飞线单元）。"""
    wire_id: str
    net_id: str
    start: Point
    end: Point
    width: float
    clearance: float
    penalty: float = 0.0

    @property
    def length(self) -> float:
        return math.hypot(self.end.x - self.start.x, self.end.y - self.start.y)

    @property
    def angle_deg(self) -> float:
        # 方向角归一化到 [0, 180)
        return math.degrees(math.atan2(self.end.y - self.start.y,
                                       self.end.x - self.start.x)) % 180.0

    @property
    def bounding_box(self) -> tuple[float, float, float, float]:
        return (min(self.start.x, self.end.x), min(self.start.y, self.end.y),
                max(self.start.x, self.end.x), max(self.start.y, self.end.y))


# ---------------------------------------------------------------------------
# 禁布区
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RectZone:
    zone_id: str
    xmin: float
    ymin: float
    xmax: float
    ymax: float


@dataclass(frozen=True)
class CircleZone:
    zone_id: str
    center: Point
    radius: float


KeepoutZone = RectZone | CircleZone


# ---------------------------------------------------------------------------
# 冲突模型
# ---------------------------------------------------------------------------

class ConflictLevel(str, Enum):
    HARD = "hard"    # 主层应错开：交叉 × 拥塞热点 / 禁布区咽喉
    SOFT = "soft"    # 仅报告：布线器可组内折弯/过孔解决
    NONE = "none"


@dataclass(frozen=True)
class Conflict:
    wire_a: str
    wire_b: str
    level: ConflictLevel
    intersect_pt: Optional[Point] = None
    clearance_gap: float = 0.0       # >0 表示间距不足（含线宽膨胀）
    dist_to_endpoints: tuple[float, float] = (0.0, 0.0)
    keepout_ids: tuple[str, ...] = ()
    congestion: float = 0.0
    reasons: tuple[str, ...] = ()


class ConflictGraph:
    """硬冲突图：节点 = wire_id，边 = 硬冲突。"""

    def __init__(self) -> None:
        self.adjacency: dict[str, set[str]] = {}

    def add_node(self, a: str) -> None:
        self.adjacency.setdefault(a, set())

    def add_edge(self, a: str, b: str) -> None:
        self.adjacency.setdefault(a, set()).add(b)
        self.adjacency.setdefault(b, set()).add(a)

    def has_edge(self, a: str, b: str) -> bool:
        return b in self.adjacency.get(a, set())

    def neighbors(self, a: str) -> set[str]:
        return self.adjacency.get(a, set())

    def nodes(self) -> list[str]:
        return list(self.adjacency.keys())

    def edges(self) -> list[tuple[str, str]]:
        seen: set[tuple[str, str]] = set()
        out: list[tuple[str, str]] = []
        for a, nbs in self.adjacency.items():
            for b in nbs:
                key = (a, b) if a < b else (b, a)
                if key not in seen:
                    seen.add(key)
                    out.append((a, b))
        return out


# ---------------------------------------------------------------------------
# 结果模型
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LayerInfo:
    layer_index: int
    kind: str = "signal"
    signal_groups: tuple[str, ...] = ()
    wires: tuple[str, ...] = ()
    nets: tuple[str, ...] = ()
    soft_conflict_count: int = 0
    max_occupancy: float = 0.0
    requires_detour: tuple[str, ...] = ()
    requires_endpoint_via: tuple[str, ...] = ()


@dataclass
class LayeringResult:
    layers: tuple[LayerInfo, ...] = ()
    assignment: dict[str, int] = field(default_factory=dict)   # wire_id -> layer_index
    plane_nets: tuple[str, ...] = ()
    hard_conflicts: tuple[Conflict, ...] = ()
    soft_conflicts: tuple[Conflict, ...] = ()
    method: str = "packing"
    iterations_used: int = 0
    capacity_lower_bound: dict[str, float] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()
    manual_route_nets: tuple[str, ...] = ()   # 同层硬冲突无法自动分层，留人工 route 的 net
