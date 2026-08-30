"""probe_layer — 探针卡飞线分层工具。

按 DESIGN.md 实现：主层分配（逐层打包 / DSATUR）+ 拥塞估计 + Allegro 反馈闭环。
"""
from .model import (  # noqa: F401
    Point,
    Units,
    LayerDef,
    LayerStack,
    SignalGroup,
    NetGroup,
    NetClass,
    Pin,
    Net,
    Wire,
    RectZone,
    CircleZone,
    KeepoutZone,
    ConflictLevel,
    Conflict,
    ConflictGraph,
    LayerInfo,
    LayeringResult,
)
from .config import LayeringConfig, default_config, load_config  # noqa: F401

__version__ = "0.1.0"
__all__ = [
    "Point", "Units", "LayerDef", "LayerStack", "SignalGroup", "NetGroup",
    "NetClass", "Pin", "Net", "Wire", "RectZone", "CircleZone", "KeepoutZone",
    "ConflictLevel", "Conflict", "ConflictGraph", "LayerInfo", "LayeringResult",
    "LayeringConfig", "default_config", "load_config",
]
