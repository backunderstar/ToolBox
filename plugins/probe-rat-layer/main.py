#!/usr/bin/env python3
"""ToolBox 插件「探针卡分层」— JSON-RPC over stdio（NDJSON）壳 + 后台任务引擎。

把原项目 `probe_layer`（探针卡飞线分层工具）包装为 ToolBox process 插件：
界面（Vue）经 `api.call` 调本文件的命令，Python 侧跑真实分层，结果落盘并回传摘要。

协议（完整约定见 ToolBox 插件开发指南 §3）：
- 宿主 -> 插件  {"id": N, "method": "init"|"call", "params": {...}}
- 插件 -> 宿主  {"id": N, "result": ...} / {"id": N, "error": {...}}
- 插件 -> 宿主  {"method": <事件名>, "params": {...}}   # Notification，无 id
- 宿主 -> 插件  {"method": "shutdown"}

命令白名单（init 握手声明）：
- layer.listDir    内置文件浏览器（path 空 = 盘符列表）
- layer.config     get / set {patch}（插件设置，存 <插件>/settings.json）
- layer.run        异步开始分层（秒回 {jobId}，后台线程跑，进度事件 + status 轮询）
- layer.status     当前任务状态 {state, jobId?, stage?, percent?, message?}
- layer.cancel     取消当前任务（threading.Event，干净退出）
- layer.result     任务摘要 + 输出文件清单（几 KB，不进 30s 超时）
- layer.readOut    读输出目录内文本（.lst / csv / report 摘要，限 4MB）
- layer.render     按需渲染图（matplotlib 懒加载）→ 返回 PNG base64 data URL
- layer.openOut    资源管理器打开输出目录（核心 API shell.exec，权限 shell）
- layer.notifyDone 完成横幅（核心 API notify，权限 notify；后台线程不能调核心 API，
                   故由 UI 收到 done 后调用本命令触发）

进度模型（关键，勿改）：
- 宿主对 process 插件的每次 call 有 30s 硬超时（manager.rs API_TIMEOUT），而 HV
  真实数据分层 ~25s、全量数据更长 → 分层必须在**后台线程**跑，`layer.run` 立即返回。
- 宿主读线程（read_loop）持续解析 stdout，但**事件只在 call 在途时**被转发到前端
  （process.rs call_raw 循环内），空闲期事件在通道积压 → 前端以轮询 `layer.status`
  为准驱动进度条；`layer.progress` 通知照发（轮询期间顺带到达，可作实时刷新）。
- 后台线程**不能调用核心 API**（宿主只在 call 期间响应核心请求）→ 本模块写输出
  文件一律用 Python 直接 open()（插件是真实 OS 进程，任意路径可读写）。
"""
from __future__ import annotations

import base64
import dataclasses
import datetime
import json
import os
import sys
import threading
import time
import traceback

# ---------- 启动准备：vendor 依赖 + UTF-8 管道 ----------

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.path.join(_PLUGIN_DIR, "vendor")
if os.path.isdir(_VENDOR) and _VENDOR not in sys.path:
    sys.path.insert(0, _VENDOR)

for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

from probe_layer.io.loader import make_loader            # noqa: E402
from probe_layer.config import default_config, load_config  # noqa: E402
from probe_layer import pipeline, report                 # noqa: E402
from probe_layer.core import geometry as geo             # noqa: E402
from probe_layer.model import (Point, Wire, LayerInfo,   # noqa: E402
                               RectZone, CircleZone)
from probe_layer.cancel import LayeringCancelled          # noqa: E402
# ⚠️ 不在这里 import probe_layer.viz：viz 顶部 import matplotlib（重依赖，首次构建
# 字体缓存可能数秒；进程被 kill 时缓存损坏会让下次启动 import 卡 30s+ → 宿主判
# 崩溃重启循环）。matplotlib 延迟到真正渲染时才加载（见 _render_one）。

_VIZ: "object | None" = None  # 惰性缓存：probe_layer.viz 模块（首次渲染时加载）


def _viz():
    """延迟加载 viz 模块（matplotlib 重依赖，只在渲染时 import 一次）。

    MPLCONFIGDIR 隔离到 <插件>/cache/mpl：matplotlib 首次 import 会构建字体缓存
    （写用户目录），若进程在构建中被 kill（宿主 30s 超时）缓存损坏会让下次 import
    卡 30s+ → 崩溃循环（2026-09 实测踩过）。隔离后损坏只影响插件自身缓存，
    且 import 前会清掉损坏残留。
    """
    global _VIZ
    if _VIZ is None:
        _mpl_dir = os.path.join(_PLUGIN_DIR, "cache", "mpl")
        try:
            os.makedirs(_mpl_dir, exist_ok=True)
            os.environ["MPLCONFIGDIR"] = _mpl_dir
        except OSError:
            pass
        from probe_layer import viz  # noqa: E402
        _VIZ = viz
    return _VIZ

_JOBS_DIR = os.path.join(_PLUGIN_DIR, "jobs")
_SETTINGS_PATH = os.path.join(_PLUGIN_DIR, "settings.json")

# stdout 写锁：主线程（响应）与后台线程（通知）共用，防行内交错
_OUT_LOCK = threading.Lock()
# matplotlib 渲染锁：cmd_render 现场渲染与后台渲染线程共用，
# matplotlib 非线程安全，任何渲染（viz / _render_manual）必须持锁
_RENDER_LOCK = threading.Lock()
# 正在后台渲染的 (job_id, kind) 集合：cmd_render 未命中时幂等启动渲染线程
_RENDER_IN_FLIGHT: set = set()
_RENDER_IN_FLIGHT_LOCK = threading.Lock()

# ---------- 后台任务引擎 ----------

# state: idle | running | done | failed | cancelled
_ACTIVE: dict = {"job_id": None, "state": "idle", "stage": "", "percent": 0.0,
                 "message": "", "error": None}
_JOBS: dict[str, dict] = {}          # job_id -> {summary, out_dir, files, cancel_event}
_STATE_LOCK = threading.Lock()


def _emit(event: str, data: dict) -> None:
    """向宿主推送 Notification（带写锁，后台线程可用）。"""
    with _OUT_LOCK:
        sys.stdout.write(json.dumps({"method": event, "params": data}, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def _set_active(state: str, stage: str = "", percent: float = 0.0,
                message: str = "", error: str | None = None) -> None:
    with _STATE_LOCK:
        _ACTIVE.update(state=state, stage=stage, percent=percent,
                       message=message, error=error)


def _job_dir(job_id: str) -> str:
    return os.path.join(_JOBS_DIR, job_id)


def _restore_jobs() -> None:
    """启动时从 jobs/<id>/meta.json 恢复已完成任务（进程重启后结果不丢）。

    进程插件由宿主随应用启动/崩溃重启自动拉起；_JOBS 是内存字典，重启即空。
    分层成功时在 job 目录写 meta.json（摘要 + 输出目录 + 文件清单），
    这里扫描恢复进 _JOBS，并把 _ACTIVE 置为最新的 done 任务——前端挂载时
    layer.status 即可拿到 jobId，结果页/图片缓存照常工作（PNG 文件本来就在
    jobs/<id>/img/ 磁盘上）。job_id 是 %Y%m%d_%H%M%S，字典序即时间序。
    """
    if not os.path.isdir(_JOBS_DIR):
        return
    restored: list[str] = []
    for name in sorted(os.listdir(_JOBS_DIR), reverse=True):
        jdir = os.path.join(_JOBS_DIR, name)
        mpath = os.path.join(jdir, "meta.json")
        if not os.path.isfile(mpath):
            continue
        try:
            with open(mpath, encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        _JOBS[name] = {
            "cancel_event": threading.Event(),
            "summary": meta.get("summary"),
            "layers_detail": meta.get("layers_detail", []),
            "out_dir": meta.get("out_dir"),
            "files": meta.get("files", []),
        }
        restored.append(name)
    if restored:
        with _STATE_LOCK:
            _ACTIVE.update(job_id=restored[0], state="done", stage="完成",
                           percent=100.0, message="完成", error=None)


def _serialize_wire(w) -> dict:
    return {"wire_id": w.wire_id, "net_id": w.net_id,
            "start": [w.start.x, w.start.y], "end": [w.end.x, w.end.y],
            "width": w.width, "clearance": w.clearance}


def _serialize_keepout(z) -> dict:
    if isinstance(z, RectZone):
        return {"type": "rect", "zone_id": z.zone_id,
                "xmin": z.xmin, "ymin": z.ymin, "xmax": z.xmax, "ymax": z.ymax}
    return {"type": "circle", "zone_id": z.zone_id,
            "center": [z.center.x, z.center.y], "radius": z.radius}


def _list_out_files(out_dir: str) -> list[str]:
    """输出目录内的相对文件清单（按格式子目录归类）。"""
    found: list[str] = []
    for root, _dirs, files in os.walk(out_dir):
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(root, f), out_dir).replace("\\", "/")
            found.append(rel)
    return sorted(found)


def _run_job(job_id: str, args: dict) -> None:
    """后台线程：加载 → 分层（带进度/取消）→ 导出 → 存结果。"""
    input_path = args.get("input", "")
    filter_path = args.get("filter") or None
    out_dir = args.get("outDir", "")
    cancel_event: threading.Event = _JOBS[job_id]["cancel_event"]
    started = time.time()

    def on_progress(pct: float, msg: str) -> None:
        _set_active("running", stage=msg, percent=pct, message=msg)
        _emit("layer.progress", {"jobId": job_id, "stage": msg,
                                 "percent": round(pct, 1), "message": msg})

    try:
        if not input_path or not os.path.isfile(input_path):
            raise ValueError(f"输入文件不存在: {input_path}")
        if not out_dir:
            raise ValueError("未指定输出目录（必填）")
        os.makedirs(out_dir, exist_ok=True)

        # 1) 读入（按扩展名选 loader）
        _set_active("running", "读入输入", 2, "读入输入")
        _emit("layer.progress", {"jobId": job_id, "stage": "读入输入",
                                 "percent": 2, "message": "读入输入"})
        inp = input_path.lower()
        if inp.endswith((".xlsx", ".xls")):
            data = make_loader("xlsx", filter_path=filter_path,
                               n_signal_layers=int(args.get("layers", 4)),
                               width=float(args.get("width", 0.2)),
                               clearance=float(args.get("clearance", 0.2))).load(input_path)
        else:
            if filter_path:
                raise ValueError("筛选文件仅用于 .xls/.xlsx 输入")
            data = make_loader().load(input_path)

        # 2) 配置：默认 + 参数覆盖（未知字段忽略）
        cfg = default_config()
        overrides = args.get("config") or {}
        if isinstance(overrides, dict):
            known = {f.name for f in dataclasses.fields(cfg)}
            bad = sorted(set(overrides) - known)
            if bad:
                _emit("layer.progress", {"jobId": job_id, "stage": "配置",
                                         "percent": 4,
                                         "message": "未知配置字段已忽略: " + ", ".join(bad)})
            cfg = dataclasses.replace(cfg, **{k: v for k, v in overrides.items() if k in known})
        # 迭代参数（UI 直接改 config 字段即可，与 CLI flags 等价）
        for fld in ("resolve_conflict_rounds", "balance_length_rounds",
                    "minimize_crossings_passes", "sa_restarts"):
            v = args.get(fld)
            if v is not None:
                cfg = dataclasses.replace(cfg, **{fld: int(v)})
        # 数值字段强转 float：UI/JSON 传来 `2` 而非 `2.0` 时，numpy 2.x 对 int 数组
        # 做 *= float 会抛 UFuncTypeError（same_kind casting，实测踩过）——统一强转
        for fld in ("sector_angle_deg", "sa_initial_temp", "sa_cooling",
                    "sa_swap_ratio", "sa_balance_slack", "congestion_grid_cell",
                    "congestion_demand_factor", "congestion_hard_threshold",
                    "layer_capacity", "capacity_utilization", "via_area_cost",
                    "pin_density_weight", "r_end", "keepout_margin_factor"):
            v = getattr(cfg, fld)
            if isinstance(v, int):
                cfg = dataclasses.replace(cfg, **{fld: float(v)})

        # 3) 分层（进度回调 + 取消事件）
        result = pipeline.run(data, cfg, on_progress=on_progress,
                              cancel_event=cancel_event)

        # 4) 导出（report.py 自动按 lst/ csv/ json/ 子目录分类）
        _set_active("running", "导出结果", 94, "导出结果")
        report.write_report(report.build_report(result, cfg), out_dir)
        report.export_layer_nets(result, out_dir)
        report.export_layer_nets_lst(result, out_dir)
        report.export_manual_route_lst(result, out_dir)
        report.export_net_layer_csv(result, out_dir)
        report.export_layer_statistics_csv(result, out_dir)

        # 5) 存供后续渲染用的几何/结果精简数据（jobs/<jobId>/）
        jdir = _job_dir(job_id)
        os.makedirs(jdir, exist_ok=True)
        with open(os.path.join(jdir, "geometry.json"), "w", encoding="utf-8") as f:
            json.dump({
                "cfg": cfg.to_dict(),
                "wires": [_serialize_wire(w) for w in data.wires],
                "keepouts": [_serialize_keepout(z) for z in data.keepouts],
            }, f, ensure_ascii=False)
        with open(os.path.join(jdir, "result.json"), "w", encoding="utf-8") as f:
            json.dump({
                "layers": [
                    {"layer": li.layer_index, "kind": li.kind,
                     "wires": list(li.wires), "nets": list(li.nets),
                     "soft_conflict_count": li.soft_conflict_count,
                     "max_occupancy": li.max_occupancy}
                    for li in result.layers
                ],
                "summary": {
                    "method": result.method,
                    "layer_count": len(result.layers),
                    "wire_assigned_count": len(result.assignment),
                    "plane_net_count": len(result.plane_nets),
                    "hard_conflict_count": len(result.hard_conflicts),
                    "soft_conflict_count": len(result.soft_conflicts),
                    "manual_route_net_count": len(result.manual_route_nets),
                    "manual_route_nets": list(result.manual_route_nets),
                    "iterations_used": result.iterations_used,
                    "warnings": list(result.warnings),
                    "capacity_lower_bound": result.capacity_lower_bound,
                },
                "manual_route_nets": list(result.manual_route_nets),
                "plane_nets": list(result.plane_nets),
            }, f, ensure_ascii=False, indent=2)

        elapsed = round(time.time() - started, 1)
        summary = {
            "method": result.method,
            "layer_count": len(result.layers),
            "wire_assigned_count": len(result.assignment),
            "plane_net_count": len(result.plane_nets),
            "hard_conflict_count": len(result.hard_conflicts),
            "soft_conflict_count": len(result.soft_conflicts),
            "manual_route_net_count": len(result.manual_route_nets),
            "manual_route_nets": list(result.manual_route_nets),
            "iterations_used": result.iterations_used,
            "warnings": list(result.warnings),
            "capacity_lower_bound": result.capacity_lower_bound,
            "elapsed_sec": elapsed,
        }
        layers_detail = [
            {"layer": li.layer_index, "kind": li.kind,
             "net_count": len(li.nets), "wire_count": len(li.wires),
             "soft_conflict_count": li.soft_conflict_count,
             "max_occupancy": li.max_occupancy}
            for li in result.layers
        ]
        with _STATE_LOCK:
            _JOBS[job_id].update(summary=summary, layers_detail=layers_detail,
                                 out_dir=out_dir, files=_list_out_files(out_dir))
            _ACTIVE.update(state="done", stage="完成", percent=100.0,
                           message="完成", error=None)
        # 结果持久化：进程重启（宿主崩溃重启/插件重载）后 layer.status/layer.result
        # 仍能恢复本任务（_restore_jobs 扫描恢复）。PNG 文件缓存本就在磁盘上。
        try:
            with open(os.path.join(jdir, "meta.json"), "w", encoding="utf-8") as f:
                json.dump({"summary": summary, "layers_detail": layers_detail,
                           "out_dir": out_dir, "files": _list_out_files(out_dir)},
                          f, ensure_ascii=False)
        except OSError:
            pass
        _emit("layer.done", {"jobId": job_id, "summary": summary})
        # ⚠️ 不做后台预渲染：预渲染线程与点击现场渲染并发首用 matplotlib，
        # 会并发构建字体缓存导致损坏（宿主 30s 超时 kill 时缓存写坏 → 后续
        # 每次重启 import matplotlib 卡 30s → 崩溃循环，2026-09 实测踩过）。
        # 点击时现场渲染（LineCollection 批量画线，0.2-0.7s），文件缓存 +
        # 前端缓存保证同一任务内二次点击秒开。
    except LayeringCancelled:
        with _STATE_LOCK:
            _JOBS[job_id].update(summary=None)
            _ACTIVE.update(state="cancelled", stage="已取消", percent=0.0,
                           message="已取消", error=None)
        _emit("layer.cancelled", {"jobId": job_id})
    except Exception as e:  # noqa: BLE001
        err = f"{e}\n{traceback.format_exc(limit=3)}"
        sys.stderr.write("[rat-layer] 任务失败: %s\n" % err)
        with _STATE_LOCK:
            _JOBS[job_id].update(summary=None)
            _ACTIVE.update(state="failed", stage="失败", percent=0.0,
                           message="失败", error=str(e))
        _emit("layer.failed", {"jobId": job_id, "error": str(e)})


# ---------- 文件浏览 / 设置 ----------

def _list_drives() -> list[dict]:
    out = []
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        root = letter + ":\\"
        if os.path.isdir(root):
            out.append({"name": root, "isDir": True, "size": None})
    return out


def cmd_list_dir(path: str | None) -> list[dict]:
    if not path:
        return _list_drives()
    if not os.path.isdir(path):
        raise ValueError(f"目录不存在: {path}")
    entries = []
    try:
        names = os.listdir(path)
    except OSError as e:
        raise ValueError(f"无法读取目录: {e}")
    for n in sorted(names, key=lambda s: (not os.path.isdir(os.path.join(path, s)), s.lower())):
        full = os.path.join(path, n)
        try:
            is_dir = os.path.isdir(full)
            size = None if is_dir else os.path.getsize(full)
        except OSError:
            is_dir, size = False, None
        entries.append({"name": n, "isDir": is_dir, "size": size})
    return entries


def _load_settings() -> dict:
    if os.path.isfile(_SETTINGS_PATH):
        try:
            with open(_SETTINGS_PATH, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    return {}


def _save_settings(data: dict) -> None:
    with open(_SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def cmd_config(args: dict) -> dict:
    action = args.get("action", "get")
    if action == "get":
        return {"settings": _load_settings()}
    if action == "set":
        patch = args.get("patch") or {}
        cur = _load_settings()
        cur.update(patch)
        _save_settings(cur)
        return {"settings": cur}
    raise ValueError(f"未知 action: {action}")


# ---------- 结果读取 / 渲染 ----------

def cmd_result(job_id: str) -> dict:
    with _STATE_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            raise ValueError(f"任务不存在: {job_id}")
        summary = job.get("summary")
        if summary is None:
            with _STATE_LOCK:
                state = _ACTIVE.get("state")
            raise ValueError(f"任务 {job_id} 无结果（状态: {state}）")
        return {"summary": summary, "layers": job.get("layers_detail", []),
                "outDir": job.get("out_dir"),
                "files": job.get("files", [])}


def cmd_report(job_id: str) -> dict:
    """report.json 原文（冲突明细截断到每级前 300 条，防超宿主 8MB 单行上限）。"""
    with _STATE_LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise ValueError(f"任务不存在: {job_id}")
    out_dir = job.get("out_dir")
    if not out_dir:
        raise ValueError("任务无输出目录")
    path = os.path.join(out_dir, "json", "report.json")
    if not os.path.isfile(path):
        raise ValueError("report.json 不存在")
    with open(path, encoding="utf-8") as f:
        rep = json.load(f)
    for level in ("hard", "soft"):
        items = rep.get("conflicts", {}).get(level, [])
        if len(items) > 300:
            rep["conflicts"][level] = items[:300]
            rep["conflicts"][f"{level}_truncated"] = True
    text = json.dumps(rep, ensure_ascii=False, indent=2)
    if len(text) > 4 * 1024 * 1024:
        raise ValueError("report.json 过大，无法在线预览（请用「打开输出目录」查看）")
    return {"text": text}


def cmd_read_out(job_id: str, rel: str) -> str:
    with _STATE_LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise ValueError(f"任务不存在: {job_id}")
    out_dir = job.get("out_dir")
    if not out_dir:
        raise ValueError("任务无输出目录")
    # 路径安全：只允许输出目录内相对路径
    target = os.path.normpath(os.path.join(out_dir, rel))
    if not target.startswith(os.path.normpath(out_dir) + os.sep) and \
            os.path.normpath(target) != os.path.normpath(out_dir):
        raise ValueError(f"路径越界: {rel}")
    if not os.path.isfile(target):
        raise ValueError(f"文件不存在: {rel}")
    size = os.path.getsize(target)
    if size > 4 * 1024 * 1024:
        raise ValueError(f"文件过大（{size} 字节，上限 4MB）: {rel}")
    with open(target, encoding="utf-8", errors="replace") as f:
        return f.read()


def _load_job_render_data(job_id: str) -> tuple[dict, dict]:
    """读取 jobs/<jobId>/ 下的几何与结果精简数据。"""
    jdir = _job_dir(job_id)
    with open(os.path.join(jdir, "geometry.json"), encoding="utf-8") as f:
        geo = json.load(f)
    with open(os.path.join(jdir, "result.json"), encoding="utf-8") as f:
        res = json.load(f)
    return geo, res


def _render_manual(wires: list, zones: tuple, out_dir: str) -> str:
    """人工 route 图：红色虚线画所有需人工的线 + 它们的交点（× 标记）。

    matplotlib 已在 viz 导入时加载；只画 manual 线（不含各层已分配线）。
    交点 = 任意两条 manual 线严格相交的位置（硬冲突来源的直观呈现）。
    线数 > 300 时跳过交点标记：O(n²) 交点计算 + 稠密标记对排障无益
    （如误配参数导致上千条人工线时，重点是"哪些线"，不是交点）。
    """
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches

    fig, ax = plt.subplots(figsize=(10, 8))
    for z in zones:
        if isinstance(z, RectZone):
            ax.add_patch(mpatches.Rectangle(
                (z.xmin, z.ymin), z.xmax - z.xmin, z.ymax - z.ymin,
                facecolor="0.85", edgecolor="red", hatch="///", alpha=0.6))
        else:
            ax.add_patch(mpatches.Circle(
                (z.center.x, z.center.y), z.radius,
                facecolor="0.85", edgecolor="red", hatch="///", alpha=0.6))
    for w in wires:
        ax.plot([w.start.x, w.end.x], [w.start.y, w.end.y],
                color="#d62728", lw=1.5, ls="--", alpha=0.8)

    # 交点（两两严格相交）：线少时 O(n²) 可接受且信息量大
    xs: list[float] = []
    ys: list[float] = []
    if len(wires) <= 300:
        for i in range(len(wires)):
            for j in range(i + 1, len(wires)):
                p = geo.seg_seg_intersection(wires[i].start, wires[i].end,
                                             wires[j].start, wires[j].end)
                if p is not None:
                    xs.append(p.x)
                    ys.append(p.y)
        if xs:
            ax.plot(xs, ys, "x", color="#000", markersize=9, mew=2)

    ax.set_aspect("equal")
    all_x = [w.start.x for w in wires] + [w.end.x for w in wires]
    all_y = [w.start.y for w in wires] + [w.end.y for w in wires]
    for z in zones:
        if isinstance(z, RectZone):
            all_x += [z.xmin, z.xmax]
            all_y += [z.ymin, z.ymax]
        else:
            all_x += [z.center.x - z.radius, z.center.x + z.radius]
            all_y += [z.center.y - z.radius, z.center.y + z.radius]
    if all_x:
        pad = max(max(all_x) - min(all_x), max(all_y) - min(all_y), 1.0) * 0.05
        ax.set_xlim(min(all_x) - pad, max(all_x) + pad)
        ax.set_ylim(min(all_y) - pad, max(all_y) + pad)
    ax.set_title(f"Manual route — {len(wires)} wires / {len(xs)} crossings")
    ax.grid(alpha=0.2)
    base = os.path.join(out_dir, "manual")
    fig.tight_layout()
    fig.savefig(base + ".png", dpi=120)
    plt.close(fig)
    return base


def _png_ready(path: str) -> bool:
    """PNG 文件是否完整：末尾带 IEND 块（matplotlib 先建文件后写内容，
    轮询可能撞上"已创建未写完"的半成品）。PNG 规范：IEND 块固定
    b"\x00\x00\x00\x00IEND\xaeB\x60\x82" 结尾。不存在或未写完 → False。"""
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - 32))
            tail = f.read()
        return tail.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")
    except OSError:
        return False


def _png_data_url(path: str) -> str:
    """读 PNG 文件 → base64 data URL（前端 <img> 直显，无需再转 Blob）。"""
    with open(path, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode("ascii")


def cmd_render(job_id: str, kind: str):
    """按需渲染指定图（layer_<i> / overview / rose / manual）。

    返回协议：
    - 缓存命中且文件完整（PNG IEND 结尾）：**base64 data URL 字符串**（前端
      `<img src>` 直显——PNG 由 matplotlib 光栅化，浏览器只解码位图，比把几千条
      `<path>` 的 SVG DOM 丢给 WebView2 光栅化快得多，实测这是"点开图还是等很久"
      的隐藏瓶颈）；
    - 未命中：启动后台渲染线程（幂等，同一 job+kind 只启一次），立即返回
      {"pending": true}——前端轮询本命令直到拿到 data URL 字符串；
    - 渲染失败（已写 .failed 标记）：抛错，前端显示明确错误。

    ⚠️ 为什么异步：宿主对 process 插件单次 call 有 30s 硬超时，超时即杀进程并
    自动重启（崩溃循环，2026-09 实测踩过多次）。matplotlib 首次加载/字体缓存
    构建在某些环境可能逼近或超过 30s。渲染放后台线程后，本命令永远秒回，
    宿主永不超时；渲染进度由前端轮询获得。
    """
    png_path = None
    name = _kind_png_name(kind)
    if name:
        png_path = os.path.join(_job_dir(job_id), "img", name)
        failed_path = png_path + ".failed"
        # 渲染失败标记：明确报错，避免前端无限 pending
        if os.path.isfile(failed_path):
            with open(failed_path, encoding="utf-8", errors="replace") as f:
                raise ValueError(f"渲染失败: {f.read().strip()}")
    # 命中缓存且文件完整：直接读，不解析 geometry/result、不调 matplotlib
    if png_path and _png_ready(png_path):
        return _png_data_url(png_path)

    key = (job_id, kind)
    with _RENDER_IN_FLIGHT_LOCK:
        if key not in _RENDER_IN_FLIGHT:
            _RENDER_IN_FLIGHT.add(key)
            threading.Thread(target=_render_async, args=(key,),
                             daemon=True).start()
    return {"pending": True}


def _render_async(key: tuple[str, str]) -> None:
    """后台渲染单张图（cmd_render 未命中时启动）。

    成功：PNG 写入 jobs/<jobId>/img/（完整后前端轮询命中）；
    失败：写 <kind>.png.failed 标记（前端读到明确错误）。
    """
    job_id, kind = key
    failed_path = None
    name = _kind_png_name(kind)
    if name:
        failed_path = os.path.join(_job_dir(job_id), "img", name + ".failed")
    try:
        _viz()  # matplotlib 预热放锁外（首次导入不阻塞其他渲染）
        with _RENDER_LOCK:
            base = _render_one(job_id, kind)
        png_path = base + ".png"
        if not os.path.isfile(png_path) or not _png_ready(png_path):
            raise ValueError("渲染无完整输出")
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("[rat-layer] 渲染失败 %s/%s: %s\n" % (job_id, kind, e))
        try:
            if failed_path:
                os.makedirs(os.path.dirname(failed_path), exist_ok=True)
                with open(failed_path, "w", encoding="utf-8") as f:
                    f.write(str(e))
        except OSError:
            pass
    finally:
        with _RENDER_IN_FLIGHT_LOCK:
            _RENDER_IN_FLIGHT.discard(key)


def _kind_png_name(kind: str) -> str | None:
    """kind → img 下缓存文件名（与渲染输出一致）；非法 kind 返回 None。"""
    cache_map = {"overview": "overview.png", "rose": "rose.png",
                 "manual": "manual.png"}
    if kind in cache_map:
        return cache_map[kind]
    if kind.startswith("layer_"):
        try:
            idx = int(kind[len("layer_"):])
        except ValueError:
            return None
        return f"layer_{idx:02d}.png"
    return None


def _render_one(job_id: str, kind: str) -> str:
    """渲染单张图（调用方必须已持有 _RENDER_LOCK）。返回 base（含扩展名前的路径）。"""
    geo, res = _load_job_render_data(job_id)
    wires = [Wire(w["wire_id"], w["net_id"], Point(*w["start"]), Point(*w["end"]),
                  w["width"], w["clearance"]) for w in geo["wires"]]
    wire_by_id = {w.wire_id: w for w in wires}
    zones = []
    for z in geo["keepouts"]:
        if z["type"] == "rect":
            zones.append(RectZone(z["zone_id"], z["xmin"], z["ymin"],
                                  z["xmax"], z["ymax"]))
        else:
            zones.append(CircleZone(z["zone_id"], Point(*z["center"]), z["radius"]))
    zones = tuple(zones)
    cfg = default_config()
    known = {f.name for f in dataclasses.fields(cfg)}
    cfg = dataclasses.replace(cfg, **{k: v for k, v in geo["cfg"].items() if k in known})

    layers = [LayerInfo(l["layer"], kind=l["kind"], wires=tuple(l["wires"]),
                        nets=tuple(l["nets"]),
                        soft_conflict_count=l["soft_conflict_count"],
                        max_occupancy=l["max_occupancy"])
              for l in res["layers"]]

    # 无冲突标记（v1：冲突明细不入图，避免读 11MB report.json；计数在表格里）
    conflicts = ()

    class _LiteResult:
        pass

    lite = _LiteResult()
    lite.layers = tuple(layers)

    img_dir = os.path.join(_job_dir(job_id), "img")
    os.makedirs(img_dir, exist_ok=True)

    # 注意：viz 各渲染函数内部自带 out_dir/img 拼接（Rat-layer 新输出结构），
    # 这里传 job 根目录，输出落到 <job>/img/；_render_manual 自己写，直接传 img_dir。
    # viz 本地改版只输出 PNG（SVG 大图 DOM 在 WebView2 光栅化慢，见 viz.py 头注释）。
    job_root = _job_dir(job_id)
    if kind == "overview":
        return _viz().render_overview(lite, wire_by_id, zones, job_root)
    if kind == "rose":
        return _viz().render_rose(lite, wire_by_id, job_root, cfg)
    if kind == "manual":
        # 需人工 route 的线：按 manual_route_nets（net 名）从几何里过滤
        manual_nets = set(res.get("manual_route_nets", []))
        manual_wires = [w for w in wires if w.net_id in manual_nets]
        if not manual_wires:
            raise ValueError("无人工 route 线（本结果全部自动分层）")
        return _render_manual(manual_wires, zones, img_dir)
    if kind.startswith("layer_"):
        idx = kind[len("layer_"):]
        li = next((l for l in layers if str(l.layer_index) == idx), None)
        if li is None:
            raise ValueError(f"层不存在: {kind}")
        return _viz().render_layer(li, wire_by_id, zones, conflicts, job_root)
    raise ValueError(f"未知渲染类型: {kind}")

# ---------- 核心 API（仅在处理 call 期间可用） ----------

def call_core(method: str, params: dict):
    """调用宿主核心 API（shell.exec / notify 等，按 plugin.json permissions 放行）。"""
    with _OUT_LOCK:
        sys.stdout.write(json.dumps({"id": 9000, "method": method, "params": params},
                                    ensure_ascii=False) + "\n")
        sys.stdout.flush()
    msg = json.loads(sys.stdin.readline())
    if "error" in msg:
        raise ValueError(msg["error"].get("message", "核心 API 错误"))
    return msg.get("result")


# ---------- 命令分发 ----------

_COMMANDS = [
    "layer.listDir", "layer.config", "layer.run", "layer.status", "layer.cancel",
    "layer.result", "layer.readOut", "layer.render", "layer.openOut",
    "layer.report", "layer.notifyDone", "plugin.action",
]


def _safe_join(workspace: str, rel: str):
    """工作区内安全拼路径：rel 越界/不存在返回 None（防插件动作逃逸工作区）。"""
    root = os.path.normpath(os.path.abspath(workspace))
    p = os.path.normpath(os.path.abspath(os.path.join(root, rel)))
    if p != root and not p.startswith(root + os.sep):
        return None
    return p


def cmd_plugin_action(args: dict) -> dict:
    """宿主外壳动作（2026-09 文件上下文动作：source="file"）。

    框架分工：宿主文件视图提供文件能力（浏览/复制/移动/删除/搜索），插件决定
    文件处理的**表现形式与业务逻辑**——本命令即插件侧实现：
    - init-project-structure  按探针卡项目规范初始化目录结构（01-原始数据/02-报告/03-归档）
    - archive-to-batch        把选中的文件/目录按当天批次归档到 03-归档/<YYYYMMDD>/
    工作区路径来自宿主注入的环境变量 TB_WORKSPACE（插件启动时=当前工作区）。
    """
    action = args.get("action", "")
    source = args.get("source", "")
    files = args.get("files") or []
    workspace = os.environ.get("TB_WORKSPACE", "")
    if source != "file":
        return {"ok": True, "message": f"忽略非文件来源动作: {source}"}
    if not workspace or not os.path.isdir(workspace):
        raise ValueError(f"工作区目录无效: {workspace}")
    if action == "init-project-structure":
        created = []
        for d in ("01-原始数据", "02-报告", "03-归档"):
            p = os.path.join(workspace, d)
            if not os.path.isdir(p):
                os.makedirs(p, exist_ok=True)
                created.append(d)
        return {"ok": True, "created": created}
    if action == "archive-to-batch":
        batch = os.path.join(workspace, "03-归档",
                             datetime.datetime.now().strftime("%Y%m%d"))
        os.makedirs(batch, exist_ok=True)
        moved = []
        for rel in files:
            src = _safe_join(workspace, rel)
            if src is None or not os.path.exists(src):
                continue
            dst = os.path.join(batch, os.path.basename(src))
            if os.path.exists(dst):  # 同名冲突：加时间戳前缀
                dst = os.path.join(
                    batch, datetime.datetime.now().strftime("%H%M%S") + "_" + os.path.basename(src))
            os.replace(src, dst)
            moved.append(rel)
        return {"ok": True, "moved": moved,
                "batch": os.path.relpath(batch, workspace)}
    return {"ok": True, "message": f"未实现动作: {action}"}


def handle_request(msg: dict) -> dict:
    mid = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") or {}
    try:
        if method == "init":
            result = {"commands": _COMMANDS}
        elif method == "call":
            command = params.get("command", "")
            args = params.get("args") or {}
            if command == "layer.listDir":
                result = cmd_list_dir(args.get("path") or None)
            elif command == "layer.config":
                result = cmd_config(args)
            elif command == "layer.run":
                with _STATE_LOCK:
                    if _ACTIVE["state"] == "running":
                        raise ValueError("已有任务在运行，请先等待或取消")
                    job_id = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                    _JOBS[job_id] = {"cancel_event": threading.Event(),
                                     "summary": None, "out_dir": None, "files": []}
                    _ACTIVE.update(job_id=job_id, state="running",
                                   stage="启动", percent=0.0, message="启动",
                                   error=None)
                threading.Thread(target=_run_job, args=(job_id, args),
                                 daemon=True).start()
                result = {"jobId": job_id}
            elif command == "layer.status":
                with _STATE_LOCK:
                    result = dict(_ACTIVE)
                    # 前端 Status 类型用 camelCase jobId；事件/run 返回也是 jobId。
                    # 历史版本返回 snake_case job_id，前端读到 undefined 导致离开页面
                    # 回来无法恢复结果（2026-09 用户反馈"离开再回来又得重头开始"）。
                    result["jobId"] = _ACTIVE.get("job_id")
            elif command == "layer.cancel":
                with _STATE_LOCK:
                    ev = _JOBS.get(_ACTIVE.get("job_id"), {}).get("cancel_event")
                if ev is not None:
                    ev.set()
                    result = {"ok": True}
                else:
                    result = {"ok": False, "message": "没有正在运行的任务"}
            elif command == "layer.result":
                result = cmd_result(args.get("jobId", ""))
            elif command == "layer.report":
                result = cmd_report(args.get("jobId", ""))
            elif command == "layer.readOut":
                result = cmd_read_out(args.get("jobId", ""), args.get("rel", ""))
            elif command == "layer.render":
                result = cmd_render(args.get("jobId", ""), args.get("kind", ""))
            elif command == "layer.openOut":
                out_dir = args.get("outDir", "")
                if not out_dir or not os.path.isdir(out_dir):
                    raise ValueError(f"目录不存在: {out_dir}")
                call_core("shell.exec",
                          {"cmd": "explorer.exe", "args": [out_dir], "timeoutSec": 10})
                result = {"ok": True}
            elif command == "layer.notifyDone":
                call_core("notify", {"title": args.get("title", "探针卡分层"),
                                     "body": args.get("body", "任务完成")})
                result = {"ok": True}
            elif command == "plugin.action":
                result = cmd_plugin_action(args)
            else:
                raise ValueError("未知命令: %s" % command)
        else:
            raise ValueError("未知方法: %s" % method)
        return {"id": mid, "result": result}
    except Exception as e:  # noqa: BLE001
        return {"id": mid, "error": {"code": -32000, "message": str(e)}}


def main():
    _restore_jobs()  # 进程重启后恢复上次完成任务（结果/状态不丢）
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("method") == "shutdown":
            with _STATE_LOCK:
                ev = _JOBS.get(_ACTIVE.get("job_id"), {}).get("cancel_event")
            if ev is not None:
                ev.set()
            break
        if "id" in msg and "method" in msg:
            with _OUT_LOCK:
                sys.stdout.write(json.dumps(handle_request(msg), ensure_ascii=False) + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    main()
