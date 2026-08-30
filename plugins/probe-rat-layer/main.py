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
- layer.render     按需渲染图（matplotlib 懒加载）→ 返回 SVG 文本
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
from probe_layer import pipeline, report, viz           # noqa: E402
from probe_layer.model import (Point, Wire, LayerInfo,   # noqa: E402
                               RectZone, CircleZone)
from probe_layer.cancel import LayeringCancelled          # noqa: E402

_JOBS_DIR = os.path.join(_PLUGIN_DIR, "jobs")
_SETTINGS_PATH = os.path.join(_PLUGIN_DIR, "settings.json")

# stdout 写锁：主线程（响应）与后台线程（通知）共用，防行内交错
_OUT_LOCK = threading.Lock()

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
        _emit("layer.done", {"jobId": job_id, "summary": summary})
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


def cmd_render(job_id: str, kind: str) -> str:
    """按需渲染指定图（layer_<i> / overview / rose）→ SVG 文本。

    matplotlib 懒加载（首次约 1.5s）；结果缓存到 jobs/<jobId>/img/。
    """
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

    if kind == "overview":
        base = viz.render_overview(lite, wire_by_id, zones, img_dir)
    elif kind == "rose":
        base = viz.render_rose(lite, wire_by_id, img_dir, cfg)
    elif kind.startswith("layer_"):
        idx = kind[len("layer_"):]
        li = next((l for l in layers if str(l.layer_index) == idx), None)
        if li is None:
            raise ValueError(f"层不存在: {kind}")
        base = viz.render_layer(li, wire_by_id, zones, conflicts, img_dir)
    else:
        raise ValueError(f"未知渲染类型: {kind}")

    svg_path = base + ".svg"
    if not os.path.isfile(svg_path):
        raise ValueError(f"渲染失败（无 SVG 输出）: {kind}")
    with open(svg_path, encoding="utf-8", errors="replace") as f:
        return f.read()


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
    "layer.report", "layer.notifyDone",
]


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
            else:
                raise ValueError("未知命令: %s" % command)
        else:
            raise ValueError("未知方法: %s" % method)
        return {"id": mid, "result": result}
    except Exception as e:  # noqa: BLE001
        return {"id": mid, "error": {"code": -32000, "message": str(e)}}


def main():
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
