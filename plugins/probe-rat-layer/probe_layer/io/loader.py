"""IDataLoader 抽象接口 + 工厂。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from ..model import (LayerStack, SignalGroup, NetGroup, Net, KeepoutZone, Wire, Units)


@dataclass(frozen=True)
class LoadedData:
    stack: LayerStack | None
    signal_groups: tuple[SignalGroup, ...] = ()
    net_groups: tuple[NetGroup, ...] = ()
    nets: tuple[Net, ...] = ()
    keepouts: tuple[KeepoutZone, ...] = ()
    wires: tuple[Wire, ...] = ()
    units: Units = Units.MM
    warnings: tuple[str, ...] = ()


class IDataLoader(Protocol):
    def load(self, path: str) -> LoadedData: ...


def make_loader(kind: str = "allegro_json", **kwargs) -> IDataLoader:
    if kind == "allegro_json":
        from .allegro_json import AllegroJsonLoader
        return AllegroJsonLoader(**kwargs)
    if kind == "xlsx":
        from .xlsx_loader import XlsxLoader
        return XlsxLoader(**kwargs)
    raise ValueError(f"未知 loader 类型: {kind!r}")
