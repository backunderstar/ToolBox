#!/usr/bin/env python3
"""py-jmes：jmespath 查询示例插件（JSON-RPC over stdio，NDJSON）。

演示要点：
1. 方案 A「vendored」第三方库（见 docs/插件开发指南.md §3.5）：
   requirements.txt 声明依赖 → 插件页「安装依赖」按钮（或构建机
   `pip install --target vendor -r requirements.txt`）装进 <插件>/vendor/，
   启动时 sys.path 插入 vendor —— 插件自包含，卸载即净，目标机无需 Python。
2. 事件推送：notify() 向宿主推 Notification（无 id），前端 api.on 订阅，
   插件页有实时事件流展示。
3. 命令白名单：init 握手时声明的命令才允许被调用。

协议（与核心约定一致，见 docs/插件开发指南.md §3）：
- 宿主 -> 插件  {"id": N, "method": "init"|"call", "params": {...}}
- 插件 -> 宿主  {"id": N, "result": ...} / {"id": N, "error": {...}}
- 插件 -> 宿主  {"method": <事件名>, "params": {...}}   # Notification，无 id
- 宿主 -> 插件  {"method": "shutdown"}
"""
import json
import os
import sys

# 方案 A：vendored 依赖放进 sys.path（vendor/ 与 main.py 同目录）
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import jmespath  # noqa: E402  第三方库（纯 Python，pip 有 wheel）


def handle_request(msg):
    """处理宿主请求（init / call），返回带 id 的响应。"""
    mid = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") or {}
    try:
        if method == "init":
            result = {"commands": ["jmes.query", "jmes.demo"]}  # 命令白名单
        elif method == "call":
            command = params.get("command", "")
            args = params.get("args") or {}
            if command == "jmes.query":
                result = {"result": jmespath.search(args.get("expr", ""), args.get("data", {}))}
            elif command == "jmes.demo":
                # 演示事件推送：处理期间逐步上报进度
                data = args.get("data", {})
                for pct in (25, 50, 75):
                    notify("progress", {"percent": pct, "message": "查询中…"})
                result = {"result": jmespath.search(args.get("expr", ""), data)}
            else:
                raise ValueError("未知命令: %s" % command)
        else:
            raise ValueError("未知方法: %s" % method)
        return {"id": mid, "result": result}
    except Exception as e:  # noqa: BLE001
        return {"id": mid, "error": {"code": -32000, "message": str(e)}}


def notify(event, params):
    """向宿主推送事件（Notification，无 id）→ 前端 api.on(event) 收到。"""
    sys.stdout.write(json.dumps({"method": event, "params": params}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    # Windows 管道强制 UTF-8（否则中文 JSON 乱码/崩溃）
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("method") == "shutdown":  # 宿主关闭信号：及时退出，不要挂起
            break
        if "id" in msg and "method" in msg:
            sys.stdout.write(json.dumps(handle_request(msg), ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
