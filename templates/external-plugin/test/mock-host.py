#!/usr/bin/env python3
"""模拟宿主：独立验证 process 插件（JSON-RPC over stdio，NDJSON）。

第三方开发时**不必启动 ToolBox** 就能验证插件协议。用法（在插件目录下）：

    python test/mock-host.py .                      # 冒烟：init + 白名单每条命令 call({})
    python test/mock-host.py . --call hello --args '{"name":"张三"}'
    python test/mock-host.py . --call eventDemo --expect-events 3
    python test/mock-host.py . --call fileList --vault D:\\docs   # 核心 API 用真实目录
    python test/mock-host.py . --call layer.run --args '{"input":"D:/x/in.xlsx","outDir":"D:/x/out"}' \
        --wait-done                                  # 异步插件：call 返回后继续收事件直到完成

做什么：
1. 读 plugin.json → 按 command spawn（默认 python main.py）
2. init 握手 → 校验命令白名单非空
3. 逐命令 call：插件若发核心 API 请求（fs.* / notify / log 等）按需模拟响应
   （fs.listDir 列 --vault 目录或临时 mock vault；其余返回 {"ok": true}）
4. 收集 Notification（事件）；--expect-events N 校验数量
5. 异步插件（后台任务，call 秒回 jobId 再推事件——宿主 30s 调用超时下长任务
   必须异步）：`--wait N` / `--wait-done` 让 mock-host 在 call 返回后继续读
   通知直到收满 N 个或出现终态事件（done/failed/cancelled），并校验成功退出
6. shutdown → 断言进程干净退出

不做（宿主才有的能力）：权限门控、事件桥到前端、CSP/Blob 注入、托盘/顶栏动作。
真实宿主行为见 ToolBox src-tauri/src/plugins/process.rs；本脚本只验证"协议对"。
"""
import argparse
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

PLUGIN_DIR = "."


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("plugin_dir", nargs="?", default=".", help="插件目录（含 plugin.json；缺省当前目录）")
    ap.add_argument("--python", default="python", help="python 可执行（缺省 PATH 里的 python）")
    ap.add_argument("--vault", default=None, help="核心 API fs.* 用真实目录；缺省用临时 mock vault")
    ap.add_argument("--call", default=None, metavar="CMD", help="只测指定命令；缺省 = 白名单全部命令冒烟")
    ap.add_argument("--args", default="{}", help="--call 的参数 JSON；PowerShell 下双引号要转义（见 README）")
    ap.add_argument("--expect-events", type=int, default=None, help="--call 期望推送的事件数（缺省不校验）")
    ap.add_argument("--wait", type=int, default=None, metavar="N",
                    help="异步插件：call 返回后继续读通知直到收满 N 个（配合 --call 用）")
    ap.add_argument("--wait-done", action="store_true",
                    help="异步插件：call 返回后继续读通知直到出现终态事件（done/failed/cancelled）")
    ap.add_argument("--wait-timeout", type=float, default=60.0,
                    help="--wait/--wait-done 的最长等待秒数（缺省 60）")
    return ap.parse_args()


def parse_args_json(raw):
    """解析 --args：先按 JSON；失败则容错"裸键"格式（PowerShell 单引号内双引号会被
    吃掉，`'{"name":"x"}'` 传进来变成 `{name:x}`）。只支持扁平键值的简单参数；
    嵌套/数组请用转义写法 `'{\\\"name\\\":\\\"x\\\"}'`。"""
    s = raw.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    if not (s.startswith("{") and s.endswith("}")):
        sys.exit(f"FAIL --args 不是合法 JSON（PowerShell 下双引号需转义，见模板 README）: {raw}")
    inner = s[1:-1].strip()
    out = {}
    if inner:
        for part in inner.split(","):
            if ":" not in part:
                sys.exit(f"FAIL --args 裸键修复失败（第 {part!r} 段缺冒号）: {raw}")
            k, v = part.split(":", 1)
            out[k.strip().strip('"').strip("'")] = coerce_arg_value(v.strip())
    return out


def coerce_arg_value(v):
    """裸键格式的值类型推断：布尔/数字/null/字符串。"""
    if v in ("true", "True"):
        return True
    if v in ("false", "False"):
        return False
    if v in ("null", "None"):
        return None
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        pass
    return v.strip('"').strip("'")


class MockHost:
    def __init__(self, plugin_dir, python, vault):
        self.plugin_dir = plugin_dir
        self.vault = vault
        self.vault_root = None  # 懒创建：core_vault() 首次调用时初始化
        self.next_id = 100
        manifest = json.load(open(os.path.join(plugin_dir, "plugin.json"), encoding="utf-8"))
        cmd = manifest.get("command")
        if not cmd:
            sys.exit("FAIL plugin.json 缺 command（process 插件应有 [\"python\", \"main.py\"]）")
        self.plugin_id = manifest.get("id", "plugin")
        # Windows 管道默认按 ANSI 代码页解码，中文 JSON 会乱码/崩溃——强制 UTF-8
        self.p = subprocess.Popen(
            [python, *cmd[1:]],
            cwd=plugin_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.p.stdin.flush()

    def recv(self, timeout=15):
        """读一行（线程 + 队列实现超时；Windows 管道不支持 select）。"""
        q = queue.Queue()
        t = threading.Thread(target=lambda: q.put(self.p.stdout.readline()), daemon=True)
        t.start()
        try:
            line = q.get(timeout=timeout)
        except queue.Empty:
            sys.exit(f"FAIL 等待插件响应超时（{timeout}s）——插件可能没读 stdin 或协议实现有误")
        if not line:
            sys.exit("FAIL 插件 stdout 已关闭（进程退出）——看插件 stderr 排查")
        return json.loads(line.strip())

    def core_vault(self):
        """fs.listDir 的根目录：--vault 指定则用真实目录，否则首次调用时建临时 mock vault。
        只建一次：插件递归 walk 期间各次 fs.listDir 必须看到同一棵树。"""
        if self.vault_root is None:
            if self.vault:
                self.vault_root = self.vault  # --vault：用真实目录
            else:
                root = tempfile.mkdtemp(prefix="tb-mock-vault-")
                for rel in ("notes/a.md", "notes/b.md", "tasks/c.md", "readme.txt"):
                    p = os.path.join(root, rel)
                    os.makedirs(os.path.dirname(p), exist_ok=True)
                    with open(p, "w", encoding="utf-8") as f:
                        f.write(f"# {rel}\n")
                self.vault_root = root
        return self.vault_root

    def respond_core(self, msg):
        """模拟宿主响应核心 API 请求（插件 call_core 是阻塞读 stdin 的，必须回）。"""
        mid = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params") or {}
        if method == "fs.listDir":
            rel = str(params.get("dir") or "")
            base = os.path.normpath(os.path.join(self.core_vault(), rel))
            # 防穿越：必须仍在 vault 根内
            if os.path.commonpath([base, self.core_vault()]) != os.path.normpath(self.core_vault()):
                return self.send({"id": mid, "error": {"code": -32602, "message": "路径越界"}})
            entries = []
            if os.path.isdir(base):
                for name in sorted(os.listdir(base)):
                    if name.startswith("."):
                        continue
                    full = os.path.join(base, name)
                    is_dir = os.path.isdir(full)
                    entries.append({
                        "name": name,
                        "path": os.path.relpath(full, self.core_vault()).replace("\\", "/"),
                        "isDir": is_dir,
                        "mtime": int(os.path.getmtime(full) * 1000) if not is_dir else None,
                    })
            self.send({"id": mid, "result": entries})
        elif method == "fs.readText":
            self.send({"id": mid, "result": "（mock-host 模拟内容）"})
        elif method in ("log", "notify", "clipboard.read", "clipboard.write", "shell.exec", "http.request", "open"):
            self.send({"id": mid, "result": {"ok": True}})
        else:
            self.send({"id": mid, "result": {"ok": True, "note": "mock-host 通用响应"}})

    def call_command(self, command, args):
        """调一条命令：自动应答核心 API 请求、收集 Notification，返回 (响应, 事件列表)。"""
        cid = self.next_id
        self.next_id += 1
        self.send({"id": cid, "method": "call", "params": {"command": command, "args": args}})
        events = []
        while True:
            msg = self.recv()
            if "id" in msg and "method" in msg:
                self.respond_core(msg)  # 插件发来的核心 API 请求（宿主应回）
                continue
            if "id" in msg and msg["id"] == cid:
                return msg, events
            if "method" in msg:  # Notification（事件推送，无 id）
                events.append(msg)
                continue
            sys.exit(f"FAIL 意外消息: {msg}")

    def wait_async(self, min_events=None, want_done=False, timeout=60.0):
        """异步插件：call 已返回，继续读通知直到收满 min_events 个或出现终态事件。

        终态事件 = method 为 done/failed/cancelled（可带前缀，如 layer.done）或
        params.state 为 done/failed/cancelled。超时按 FAIL 处理（任务可能挂死）。
        返回 (事件列表, 终态方法 or None)。"""
        deadline = time.monotonic() + timeout
        events = []
        terminal = None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                sys.exit(
                    f"FAIL 等待异步任务 {timeout}s 超时——任务可能挂死；已收事件 {len(events)} 个"
                )
            msg = self.recv(timeout=remaining)
            if "id" in msg and "method" in msg:
                self.respond_core(msg)
                continue
            if "method" in msg:
                events.append(msg)
                m = msg["method"]
                if (m.endswith(".done") or m.endswith(".failed") or m.endswith(".cancelled")
                        or m in ("done", "failed", "cancelled")):
                    terminal = m
                state = (msg.get("params") or {}).get("state")
                if state in ("done", "failed", "cancelled"):
                    terminal = m
                if terminal is not None or (min_events is not None and len(events) >= min_events):
                    return events, terminal
                continue
            if "id" in msg:
                continue  # 不匹配的响应（不应出现），忽略
            sys.exit(f"FAIL 意外消息: {msg}")

    def shutdown(self):
        self.send({"method": "shutdown"})
        try:
            self.p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.p.kill()
            sys.exit("FAIL shutdown 后插件未在 5s 内退出（main 循环没处理 shutdown 信号？）")


def main():
    # 控制台编码跟随系统（GBK 控制台显示中文不乱码），仅兜底异常字符
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    args = parse_args()
    host = MockHost(args.plugin_dir, args.python, args.vault)

    # 1. init 握手
    host.send({"id": 1, "method": "init", "params": {"apiVersion": 1, "pluginId": host.plugin_id}})
    r = host.recv()
    if "error" in r:
        sys.exit(f"FAIL init 被拒: {r['error']}")
    commands = r.get("result", {}).get("commands") or []
    if not commands:
        sys.exit("FAIL init 返回空命令白名单")
    print(f"PASS init 命令白名单（{len(commands)} 个）: {', '.join(commands)}")

    # 2. 逐命令 call
    if args.call:
        targets = [args.call]
    else:
        targets = commands  # 冒烟：白名单全部跑一遍
    for cmd in targets:
        call_args = parse_args_json(args.args) if args.call else {}
        resp, events = host.call_command(cmd, call_args)
        if "error" in resp:
            print(f"WARN {cmd} 返回 error（参数不完整？）: {resp['error']['message']}")
            if args.call:
                sys.exit(1)
            continue
        print(f"PASS {cmd} → {json.dumps(resp['result'], ensure_ascii=False)[:120]}")
        if events:
            names = ", ".join(f"{e['method']}({json.dumps(e.get('params'), ensure_ascii=False)})" for e in events)
            print(f"      事件 ×{len(events)}: {names}")
        if args.expect_events is not None and len(events) != args.expect_events:
            sys.exit(f"FAIL {cmd} 应推送 {args.expect_events} 个事件，实际 {len(events)}")
        # 异步插件：call 已返回，继续等后台任务事件（宿主 30s 超时下长任务必须异步）
        if args.wait is not None or args.wait_done:
            tail_events, terminal = host.wait_async(
                min_events=args.wait,
                want_done=args.wait_done,
                timeout=args.wait_timeout,
            )
            names = ", ".join(f"{e['method']}" for e in tail_events)
            print(f"      异步事件 ×{len(tail_events)}（call 返回后）: {names}")
            if args.wait is not None and len(tail_events) < args.wait:
                sys.exit(f"FAIL {cmd} 异步事件应 ≥{args.wait} 个，实际 {len(tail_events)}")
            if args.wait_done:
                if terminal is None:
                    sys.exit(f"FAIL {cmd} 未出现终态事件（done/failed/cancelled）")
                if terminal.endswith((".failed", ".cancelled")) or terminal in ("failed", "cancelled"):
                    sys.exit(f"FAIL {cmd} 异步任务终态为失败/取消: {terminal}")

    # 3. shutdown 干净退出
    host.shutdown()
    print("PASS shutdown 干净退出")


if __name__ == "__main__":
    main()
