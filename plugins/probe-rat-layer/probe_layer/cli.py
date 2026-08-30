"""命令行入口。

暂定输入约定（2 个文件）：
1. `--input`：Allegro 导出的 pin 表（.xls/.xlsx，含 pin/net/坐标）；
2. `--filter`：筛选文件，**默认 .lst**（一行一个 net 名，空行/# 注释跳过），
   也兼容 .xls/.xlsx（第一列是 net 名）。不在筛选文件里的 net 全部不要。
"""
from __future__ import annotations

import argparse
import dataclasses
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from .config import load_config, default_config
from .io.loader import make_loader
from . import pipeline, report, viz


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="probe_layer", description="探针卡飞线分层")
    p.add_argument("--input", required=True,
                   help="输入 1：Allegro 导出的 pin 表（.xls/.xlsx）；兼容旧 JSON（.json）")
    p.add_argument("--filter",
                   help="输入 2：筛选文件，默认 .lst/.txt（一行一个 net，空行/# 注释跳过）；"
                        "兼容 .xls/.xlsx（第一列 net 名）。不在其中的 net 全部不要")
    p.add_argument("--config", help="LayeringConfig JSON（可选覆盖默认参数）")
    p.add_argument("--out", default="out", help="输出目录")
    p.add_argument("--method", choices=["packing", "dsatur"], help="覆盖分层方法")
    p.add_argument("--layers", type=int, default=4, help="信号层数（xls/xlsx 输入时）")
    p.add_argument("--width", type=float, default=0.2, help="信号线宽 mm（xls/xlsx 输入时）")
    p.add_argument("--clearance", type=float, default=0.2, help="信号线距 mm（xls/xlsx 输入时）")
    # —— 迭代参数（各启发式轮数，可覆盖 config；不传用 config 默认值）——
    p.add_argument("--resolve-conflict-rounds", type=int, default=None,
                   help="同层硬冲突微调轮数（默认 8）")
    p.add_argument("--balance-length-rounds", type=int, default=None,
                   help="长短均衡交换轮数（默认 3）")
    p.add_argument("--minimize-crossings-passes", type=int, default=None,
                   help="贪心交叉最小化轮数（默认 3）")
    p.add_argument("--sa-restarts", type=int, default=None,
                   help="SA 多起点次数（默认 1）")
    p.add_argument("--feedback", help="Allegro 布线反馈文件（闭环迭代）")
    p.add_argument("--render-svg", action="store_true", help="渲染图（PNG+SVG）")
    p.add_argument("--render-congestion", action="store_true", help="渲染拥塞热力图")
    args = p.parse_args(argv)

    cfg = load_config(args.config) if args.config else default_config()
    for fld, val in (("method", args.method),
                     ("resolve_conflict_rounds", args.resolve_conflict_rounds),
                     ("balance_length_rounds", args.balance_length_rounds),
                     ("minimize_crossings_passes", args.minimize_crossings_passes),
                     ("sa_restarts", args.sa_restarts)):
        if val is not None:
            cfg = dataclasses.replace(cfg, **{fld: val})
    if args.render_svg:
        cfg = dataclasses.replace(cfg, render_svg=True)
    if args.render_congestion:
        cfg = dataclasses.replace(cfg, render_congestion=True)

    inp = args.input.lower()
    if inp.endswith((".xlsx", ".xls")):
        data = make_loader("xlsx", filter_path=args.filter,
                           n_signal_layers=args.layers,
                           width=args.width, clearance=args.clearance).load(args.input)
    else:
        if args.filter:
            p.error("--filter 仅用于 xls/xlsx 输入")
        data = make_loader().load(args.input)
    result = pipeline.run(data, cfg, args.feedback)

    os.makedirs(args.out, exist_ok=True)
    report.write_report(report.build_report(result, cfg), args.out)
    report.export_layer_nets(result, args.out)
    lst = report.export_layer_nets_lst(result, args.out)
    manual = report.export_manual_route_lst(result, args.out)
    csv_net = report.export_net_layer_csv(result, args.out)
    csv_stat = report.export_layer_statistics_csv(result, args.out)
    print(report.print_summary(result))
    print(f"Allegro 层列表: {lst}")
    print(f"人工 route 清单: {manual}")
    print(f"net 分层 CSV: {csv_net}")
    print(f"层统计 CSV: {csv_stat}")

    if cfg.render_svg:
        wire_by_id = {w.wire_id: w for w in data.wires}
        viz.render_all(result, wire_by_id, data.keepouts, args.out, cfg)
    print(f"输出目录: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
