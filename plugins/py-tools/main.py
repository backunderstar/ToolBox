#!/usr/bin/env python3
"""py-tools：Python 文本工具插件示例（JSON-RPC over stdio，NDJSON）。

演示要点：
1. 完整协议实现：init / call / Notification（事件）/ shutdown
2. 第三方库的 vendored 放置（教程 §5.1 方案 B）：
   依赖装进插件目录 vendor/（`pip install --target vendor python-dateutil`），
   启动时 sys.path 插入——插件自包含，卸载即净，不污染系统 Python。
3. 事件推送：宿主转发为 plugin-event，前端 api.on 订阅。

协议（与核心约定，见 docs/插件开发指南.md §3）：
- 宿主 -> 插件  {"id": N, "method": "init"|"call", "params": {...}}
- 插件 -> 宿主  {"id": N, "result": ...} / {"id": N, "error": {...}}
- 插件 -> 宿主  {"method": <事件名>, "params": {...}}   # Notification，无 id
- 宿主 -> 插件  {"method": "shutdown"}
"""
import json
import os
import sys

# 第三方库 vendored 放置：vendor/ 与 main.py 同目录
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

from dateutil import parser as date_parser  # noqa: E402  第三方库（python-dateutil）


def handle_request(msg):
    """处理宿主请求（init / call），返回带 id 的响应。"""
    mid = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") or {}
    try:
        if method == "init":
            result = {"commands": ["pytext.stats", "pytext.humanDate", "pytext.eventDemo"]}
        elif method == "call":
            command = params.get("command", "")
            args = params.get("args") or {}
            if command == "pytext.stats":
                result = text_stats(args.get("text", ""))
            elif command == "pytext.humanDate":
                result = human_date(args.get("date", ""), args.get("fmt", "%Y-%m-%d"))
            elif command == "pytext.eventDemo":
                result = event_demo(args)
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


def text_stats(text):
    """标准库统计：字数 / 行数 / 段落数 / 非空行。"""
    lines = text.splitlines()
    non_empty = [ln for ln in lines if ln.strip()]
    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    return {
        "chars": len(text),
        "lines": len(lines),
        "nonEmptyLines": len(non_empty),
        "paragraphs": len(paragraphs),
        "words": len(text.split()),
    }


def human_date(date_str, fmt):
    """第三方库 demo：dateutil 解析任意格式日期 → 统一格式输出。

    展示 vendored 依赖在插件进程内真实可用（dateutil.parser 处理时区/多格式）。
    """
    if not date_str.strip():
        raise ValueError("缺少 date 参数")
    parsed = date_parser.parse(date_str)
    return {"parsed": parsed.isoformat(), "formatted": parsed.strftime(fmt)}


def event_demo(args):
    """事件 demo：边处理边推送 progress 事件（照抄 csv-tool 的 eventTest）。"""
    percent = int(args.get("percent", 42))
    for step in range(1, 4):
        notify("progress", {"percent": int(percent * step / 3), "message": "处理中 %s/3" % step})
    return {"text": "已发送 %d 个进度事件" % step}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("method") == "shutdown":
            break
        if "id" in msg and "method" in msg:
            sys.stdout.write(json.dumps(handle_request(msg), ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
