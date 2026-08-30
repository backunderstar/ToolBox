#!/usr/bin/env python3
"""探针卡分层插件协议测试（独立于 ToolBox，不启动宿主）。

生成一个小型合成探针卡 pin 表（xlsx）+ 筛选文件（.lst），经 JSON-RPC 全链路
验证异步任务模型：init → layer.listDir → layer.run（秒回 jobId）→ 轮询
layer.status 直到 done → layer.result / layer.readOut / layer.render /
layer.report → shutdown 干净退出。

用法（需 shapely/numpy/matplotlib/openpyxl/xlrd，可用插件 vendor 或开发 venv）：
    python test/protocol_test.py [--python <解释器>]
"""
import argparse
import json
import math
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_inputs(out_dir):
    """生成合成 pin 表（8 扇区 × 6 条径向 2-pin net = 48 net）与筛选文件。"""
    xlsx_path = os.path.join(out_dir, "pins.xlsx")
    lst_path = os.path.join(out_dir, "filter.lst")

    from openpyxl import Workbook  # 延迟导入：本测试需要 openpyxl
    wb = Workbook()
    ws = wb.active
    ws.append(["REFDES", "PIN_NUMBER", "SYM_NAME", "COMP_DEVICE_TYPE",
               "PAD_STACK_NAME", "PIN_X", "PIN_Y", "NET_NAME"])
    nets = []
    for s in range(8):
        for k in range(6):
            theta = math.radians(s * 45 + 3)
            nets.append((s, k, theta))
    for s, k, theta in nets:
        name = f"HVS{s}_{k}"
        inner_r, outer_r = 15.0, 200.0
        ws.append([f"U{s}", "1", "PAD", "PIN", "SMD", round(inner_r * math.cos(theta), 3),
                   round(inner_r * math.sin(theta), 3), name])
        ws.append([f"U{s}", "2", "PAD", "PIN", "SMD", round(outer_r * math.cos(theta), 3),
                   round(outer_r * math.sin(theta), 3), name])
    wb.save(xlsx_path)

    # 筛选：均匀覆盖 8 个扇区（每扇区取一半），模拟原项目 filter_example.lst 风格
    with open(lst_path, "w", encoding="utf-8") as f:
        f.write("# 合成筛选：每扇区 3 条，共 24 条\n")
        for s in range(8):
            for k in range(3):
                f.write(f"HVS{s}_{k}\n")
    return xlsx_path, lst_path


class PluginClient:
    """极简 JSON-RPC 客户端（对应宿主 plugins/process.rs 行为）。"""

    def __init__(self, python):
        self.p = subprocess.Popen(
            [python, "main.py"], cwd=PLUGIN_DIR,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
        )
        self.next_id = 1

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.p.stdin.flush()

    def recv(self, timeout=15):
        q = queue.Queue()
        t = threading.Thread(target=lambda: q.put(self.p.stdout.readline()), daemon=True)
        t.start()
        try:
            line = q.get(timeout=timeout)
        except queue.Empty:
            fail(f"等待响应超时（{timeout}s）")
        if not line:
            err = self.p.stderr.read() or "(无 stderr)"
            fail(f"插件 stdout 关闭（进程退出）:\n{err}")
        return json.loads(line.strip())

    def call(self, command, args=None, timeout=15, expect_error=False):
        cid = self.next_id
        self.next_id += 1
        self.send({"id": cid, "method": "call",
                   "params": {"command": command, "args": args or {}}})
        while True:
            msg = self.recv(timeout)
            if "id" in msg and "method" in msg:
                fail("插件发来核心 API 请求（本测试不涉及）: %s" % msg["method"])
            if "id" in msg and msg["id"] == cid:
                if "error" in msg:
                    if expect_error:
                        return {"_error": msg["error"]["message"]}
                    fail(f"{command} 返回 error: {msg['error']['message']}")
                return msg["result"]
            if "method" in msg:
                continue  # 事件（run 期间），忽略，靠 status 轮询

    def status_until(self, terminal_states, timeout=120):
        """轮询 layer.status 直到进入终态（模拟宿主 30s 超时下的 UI 轮询）。"""
        deadline = time.monotonic() + timeout
        progress = []
        while time.monotonic() < deadline:
            st = self.call("layer.status")
            progress.append(st)
            if st["state"] in terminal_states:
                return st, progress
            time.sleep(0.2)
        fail(f"status 轮询 {timeout}s 未进入终态 {terminal_states}")

    def shutdown(self):
        self.send({"method": "shutdown"})
        try:
            self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.p.kill()
            fail("shutdown 后未在 5s 内退出")


def fail(msg):
    sys.exit(f"FAIL {msg}")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--python", default="python",
                    help="解释器（需含全部依赖；缺省 PATH 里的 python）")
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="rat-layer-test-")
    out_dir = os.path.join(tmp, "out")
    os.makedirs(out_dir, exist_ok=True)
    xlsx, lst = make_inputs(tmp)
    print(f"PASS 生成合成输入: {xlsx} + {lst}")

    c = PluginClient(args.python)
    try:
        # 1. init
        c.send({"id": 0, "method": "init",
                "params": {"apiVersion": 1, "pluginId": "probe-rat-layer"}})
        r = c.recv()
        commands = r.get("result", {}).get("commands") or []
        need = {"layer.run", "layer.status", "layer.cancel", "layer.result",
                "layer.readOut", "layer.render", "layer.listDir", "layer.report"}
        missing = need - set(commands)
        if missing:
            fail(f"命令白名单缺: {sorted(missing)}")
        print(f"PASS init 命令白名单（{len(commands)} 个）")

        # 2. 文件浏览（盘符列表 + 具体目录）
        drives = c.call("layer.listDir")
        if not isinstance(drives, list):
            fail("layer.listDir 应返回列表")
        entries = c.call("layer.listDir", {"path": tmp})
        if not any(e["name"] == "out" and e["isDir"] for e in entries):
            fail("layer.listDir 未列出 out 目录")
        print(f"PASS layer.listDir（盘符 {len(drives)} 个，目录条目 {len(entries)} 个）")

        # 3. 异步分层：layer.run 应秒回 jobId
        t0 = time.monotonic()
        run_r = c.call("layer.run", {
            "input": xlsx, "filter": lst, "outDir": out_dir,
            "layers": 4, "width": 0.2, "clearance": 0.2,
            "config": {"congestion_grid_cell": 2.0,
                       "congestion_hard_threshold": 3.0},
        })
        dt = time.monotonic() - t0
        job_id = run_r.get("jobId")
        if not job_id:
            fail("layer.run 未返回 jobId")
        if dt > 5:
            fail(f"layer.run 应秒回（异步），实际 {dt:.1f}s")
        print(f"PASS layer.run → jobId={job_id}（{dt:.1f}s 返回）")

        # 4. 轮询 status 直到 done（异步任务在后台线程跑完）
        st, progress = c.status_until(("done", "failed", "cancelled"))
        if st["state"] != "done":
            fail(f"任务终态异常: {st}")
        if st.get("jobId") != job_id:
            fail(f"layer.status 未返回 jobId（camelCase，前端靠它恢复结果）: {st}")
        if not any(p["state"] == "running" and p.get("percent") for p in progress):
            fail("未观察到进度阶段（status 轮询应带回 percent/stage）")
        print(f"PASS 异步完成（轮询 {len(progress)} 次，末状态 percent={st.get('percent')}）")

        # 5. 结果与输出文件
        res = c.call("layer.result", {"jobId": job_id})
        s = res["summary"]
        if s["layer_count"] != 4 or s["wire_assigned_count"] <= 0:
            fail(f"摘要异常: layer_count={s['layer_count']} wires={s['wire_assigned_count']}")
        files = res.get("files") or []
        for want in ("lst/layer_1.lst", "json/report.json", "csv/layer_statistics.csv"):
            if want not in files:
                fail(f"输出文件缺 {want}（实际: {files}）")
        print(f"PASS layer.result（{s['wire_assigned_count']} 线 / {s['layer_count']} 层 / "
              f"软冲突 {s['soft_conflict_count']} / 耗时 {s['elapsed_sec']}s）")

        # 6. 读 .lst 输出
        lst_text = c.call("layer.readOut", {"jobId": job_id, "rel": "lst/layer_1.lst"})
        if not lst_text.strip():
            fail("layer_1.lst 为空")
        print(f"PASS layer.readOut lst/layer_1.lst（{len(lst_text.splitlines())} 行）")

        # 7. 按需渲染 PNG（异步：未命中返回 {"pending":true}，轮询直到拿到 data URL）
        svg = c.call("layer.render", {"jobId": job_id, "kind": "layer_1"})
        t_render = time.monotonic()
        while isinstance(svg, dict) and svg.get("pending"):
            time.sleep(0.3)
            svg = c.call("layer.render", {"jobId": job_id, "kind": "layer_1"})
            if time.monotonic() - t_render > 120:
                fail("layer.render 轮询 120s 未完成（后台渲染卡住？）")
        if not isinstance(svg, str) or not svg.startswith("data:image/png;base64,"):
            fail(f"layer.render 未返回 PNG data URL（实际: {type(svg).__name__} "
                 f"len={len(svg) if isinstance(svg,str) else '?'} {str(svg)[:120]!r}）")
        print(f"PASS layer.render layer_1（PNG data URL，{len(svg)} 字节，"
              f"{time.monotonic() - t_render:.1f}s）")
        # 二次调用应缓存命中（data URL 秒回）
        t2 = time.monotonic()
        svg2 = c.call("layer.render", {"jobId": job_id, "kind": "layer_1"})
        if not isinstance(svg2, str) or svg2 != svg:
            fail("layer.render 二次调用未命中缓存")
        print(f"PASS layer.render 二次调用缓存命中（{time.monotonic() - t2:.2f}s）")

        # 8. report.json 预览（冲突截断）
        rep = c.call("layer.report", {"jobId": job_id})
        if '"summary"' not in rep["text"]:
            fail("layer.report 内容异常")
        print("PASS layer.report（report.json 预览）")

        # 9. 路径越界防护
        err = c.call("layer.readOut", {"jobId": job_id, "rel": "../main.py"},
                     expect_error=True)
        if not isinstance(err, dict) or "_error" not in err:
            fail("layer.readOut 越界应被拒")
        print(f"PASS 路径越界被拒: {err['_error']}")

        # 10. 重启恢复：新起进程（模拟宿主重启插件/应用）→ layer.status 应恢复 done + jobId
        c2 = PluginClient(args.python)
        try:
            c2.send({"id": 0, "method": "init",
                     "params": {"apiVersion": 1, "pluginId": "probe-rat-layer"}})
            r2 = c2.recv()
            st2 = c2.call("layer.status")
            if st2["state"] != "done" or st2.get("jobId") != job_id:
                fail(f"重启后未恢复上次任务（state={st2['state']} jobId={st2.get('jobId')}）")
            res2 = c2.call("layer.result", {"jobId": job_id})
            if res2["summary"]["layer_count"] != 4:
                fail("重启后 layer.result 摘要异常")
            print("PASS 进程重启后恢复上次任务（status done + result 可读，前端不用重头开始）")
        finally:
            c2.shutdown()

        # 11. shutdown
        c.shutdown()
        print("PASS shutdown 干净退出")
    finally:
        try:
            c.p.kill()
        except Exception:
            pass


if __name__ == "__main__":
    main()
