#!/usr/bin/env python3
"""CSV 工具插件：JSON-RPC over stdio（NDJSON）。

协议（与核心约定）：
- 每行一个 JSON 对象
- 核心 -> 插件: {"id": N, "method": "init"|"call", "params": {...}}
- 插件 -> 核心: {"id": N, "result": ...} / {"id": N, "error": {...}}
- 核心 -> 插件: {"method": "shutdown"}  退出信号

任意语言只需实现该协议即可成为 ToolBox 插件。
"""
import csv
import io
import json
import sys


def handle_request(msg):
    mid = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") or {}
    try:
        if method == "init":
            result = {"commands": ["csv.convert", "csv.eventTest"]}
        elif method == "call":
            command = params.get("command", "")
            if command == "csv.convert":
                result = convert(params.get("args") or {})
            elif command == "csv.eventTest":
                result = event_test(params.get("args") or {})
            else:
                raise ValueError("未知命令: %s" % command)
        else:
            raise ValueError("未知方法: %s" % method)
        return {"id": mid, "result": result}
    except Exception as e:  # noqa: BLE001
        return {"id": mid, "error": {"code": -32000, "message": str(e)}}


def notify(event, params):
    """向核心推送事件（Notification，无 id）——事件桥示例。"""
    sys.stdout.write(
        json.dumps({"method": event, "params": params}, ensure_ascii=False) + "\n"
    )
    sys.stdout.flush()


def event_test(args):
    percent = int(args.get("percent", 42))
    # 模拟耗时任务：边处理边汇报进度事件
    for step in range(1, 4):
        notify(
            "progress",
            {"percent": int(percent * step / 3), "message": "模拟进度 %s/3" % step},
        )
    return {"text": "已发送 %d 个进度事件" % step}


def convert(args):
    text = args.get("csv", "")
    fmt = args.get("format", "json")
    rows = list(csv.reader(io.StringIO(text)))
    if fmt == "tsv":
        return {"text": "\n".join("\t".join(r) for r in rows)}
    if not rows:
        return {"text": "[]"}
    header = rows[0]
    data = [dict(zip(header, r)) for r in rows[1:]]
    return {"text": json.dumps(data, ensure_ascii=False, indent=2)}


def main():
    # 协议约定 UTF-8；Windows 管道下默认 ANSI 代码页（GBK），强制 UTF-8
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stderr.write("bad json: %s\n" % e)
            continue
        if msg.get("method") == "shutdown":
            break
        if msg.get("method") in ("init", "call") and "id" in msg:
            sys.stdout.write(
                json.dumps(handle_request(msg), ensure_ascii=False) + "\n"
            )
            sys.stdout.flush()


if __name__ == "__main__":
    main()
