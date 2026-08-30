"""xlsx loader + net 白名单筛选测试。"""
from __future__ import annotations

import openpyxl

from probe_layer.io.loader import make_loader
from probe_layer.model import NetClass

_HEADER = ["REFDES", "PIN_NUMBER", "SYM_NAME", "COMP_DEVICE_TYPE",
           "PAD_STACK_NAME", "PIN_X", "PIN_Y", "NET_NAME"]
_ROWS = [
    ["U1", "1", "S", "C", "P", 0.0, 0.0, "NET_A"],
    ["U1", "2", "S", "C", "P", 10.0, 0.0, "NET_A"],
    ["U2", "1", "S", "C", "P", 0.0, 5.0, "NET_B"],
    ["U2", "2", "S", "C", "P", 10.0, 5.0, "NET_B"],
    ["U3", "1", "S", "C", "P", 0.0, 8.0, "NET_C"],    # 单 pin → 删
    ["U4", "1", "S", "C", "P", 0.0, 9.0, "NC"],        # NC → 删
    ["U5", "1", "S", "C", "P", 0.0, 10.0, "GND"],      # 地 → plane
    ["U5", "2", "S", "C", "P", 1.0, 10.0, "GND"],
    ["U6", "1", "S", "C", "P", 0.0, 11.0, "V5P"],      # 电源 → plane
    ["U6", "2", "S", "C", "P", 1.0, 11.0, "V5P"],
]


def _write_xlsx(path, header, rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(header)
    for r in rows:
        ws.append(r)
    wb.save(path)


def test_xlsx_loader_no_filter(tmp_path):
    pin = tmp_path / "pins.xlsx"
    _write_xlsx(pin, _HEADER, _ROWS)
    loaded = make_loader("xlsx").load(str(pin))
    assert {n.net_id for n in loaded.nets} == {"NET_A", "NET_B", "GND", "V5P"}
    assert len(loaded.wires) == 2              # 只有 NET_A/NET_B 生成飞线
    assert loaded.stack.signal_layers() == (1, 2, 3, 4)


def test_xlsx_loader_with_whitelist(tmp_path):
    pin = tmp_path / "pins.xlsx"
    _write_xlsx(pin, _HEADER, _ROWS)
    flt = tmp_path / "filter.xlsx"
    _write_xlsx(flt, ["net_name"], [["NET_A"], ["GND"]])   # 表头自动跳过
    loaded = make_loader("xlsx", filter_path=str(flt)).load(str(pin))
    net_ids = {n.net_id: n for n in loaded.nets}
    assert set(net_ids) == {"NET_A", "GND"}    # 白名单外全部不要
    assert net_ids["NET_A"].net_class == NetClass.SIGNAL
    assert net_ids["GND"].net_class == NetClass.GROUND
    assert len(loaded.wires) == 1              # 只有 NET_A
    assert any("白名单" in w for w in loaded.warnings)


def test_xlsx_loader_with_lst_filter(tmp_path):
    """默认筛选格式：.lst 纯文本，一行一个 net（空行/# 注释跳过）。"""
    pin = tmp_path / "pins.xlsx"
    _write_xlsx(pin, _HEADER, _ROWS)
    flt = tmp_path / "filter.lst"
    flt.write_text("# 注释行\n\nNET_B\nGND\n", encoding="utf-8")
    loaded = make_loader("xlsx", filter_path=str(flt)).load(str(pin))
    net_ids = {n.net_id: n for n in loaded.nets}
    assert set(net_ids) == {"NET_B", "GND"}    # 一行一个 net，空行/注释跳过
    assert len(loaded.wires) == 1              # 只有 NET_B
    assert any("白名单" in w for w in loaded.warnings)
