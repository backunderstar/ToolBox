#!/usr/bin/env python3
"""外部插件模板：Python 进程插件骨架（JSON-RPC over stdio，NDJSON）。

协议（完整约定见 ToolBox 插件开发指南 §3）：
- 宿主 -> 插件  {"id": N, "method": "init"|"call", "params": {...}}
- 插件 -> 宿主  {"id": N, "result": ...} / {"id": N, "error": {...}}
- 插件 -> 宿主  {"method": <事件名>, "params": {...}}   # Notification，无 id
- 宿主 -> 插件  {"method": "shutdown"}

开发要点：
1. 解释器用宿主三级解析：插件自带 python.exe → 全局捆绑运行时 → 系统 PATH，
   目标机无需装 Python（command 保持 ["python", "main.py"] 即可）。
2. 第三方库放 <插件>/vendor/（`pip install --target vendor <pkg>`，或插件页
   「安装依赖」按钮，需在 plugin.json 旁放 requirements.txt）；main.py 启动时
   把 vendor 插进 sys.path（见下注释示例）。
3. 命令白名单：init 握手声明的 commands 才允许被调用。
4. 事件推送：notify() 写 stdout（Notification），前端 api.on(event) 订阅。
"""
import json
import sys

# 方案 A（vendored 依赖）：有 vendor/ 目录时取消注释，把依赖装进 vendor/
# import os
# sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))


def handle_request(msg):
    """处理宿主请求（init / call），返回带 id 的响应。"""
    mid = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") or {}
    try:
        if method == "init":
            # 命令白名单：在这里声明本插件可被调用的命令
            result = {"commands": ["hello", "eventDemo"]}
        elif method == "call":
            command = params.get("command", "")
            args = params.get("args") or {}
            if command == "hello":
                result = {"message": "你好，来自 Python 插件！"}
            elif command == "eventDemo":
                for pct in (30, 60, 100):
                    notify("progress", {"percent": pct, "message": "处理中…"})
                result = {"text": "已发送 3 个进度事件"}
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
    for stream in (sys.stdin, sys.stdout, sys.stderr):
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
