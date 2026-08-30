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
            result = {
                "commands": [
                    "pytext.stats",
                    "pytext.humanDate",
                    "pytext.eventDemo",
                    "search.provide",
                ]
            }
        elif method == "call":
            command = params.get("command", "")
            args = params.get("args") or {}
            if command == "pytext.stats":
                result = text_stats(args.get("text", ""))
            elif command == "pytext.humanDate":
                result = human_date(args.get("date", ""), args.get("fmt", "%Y-%m-%d"))
            elif command == "pytext.eventDemo":
                result = event_demo(args)
            elif command == "search.provide":
                result = search_provide(args)
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


def call_core(method, params):
    """调用核心 API（fs.readText / fs.listDir 等，按 plugin.json 的 permissions 放行）。

    插件 → 宿主发 {"id": N, "method": <核心 API>, "params": {...}}，宿主响应同 id。
    返回响应里的 result 字段（错误则抛异常）。注意：必须在处理 call 请求期间调用
    （宿主在该期间会响应核心请求）。
    """
    sys.stdout.write(json.dumps({"id": 9000, "method": method, "params": params}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    msg = json.loads(sys.stdin.readline())
    if "error" in msg:
        err = msg["error"]
        raise ValueError(err.get("message", "核心 API 错误"))
    return msg.get("result")


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
    """事件 demo：边处理边推送 progress 事件（与模板 main.py 的 notifyDemo 同构）。"""
    percent = int(args.get("percent", 42))
    for step in range(1, 4):
        notify("progress", {"percent": int(percent * step / 3), "message": "处理中 %s/3" % step})
    return {"text": "已发送 %d 个进度事件" % step}


def search_provide(args):
    """搜索提供者（manifest searchProvider: true 后进入全局搜索聚合）。

    宿主 search_all 调用 search.provide {query, limit} → 返回 [{path, title, snippet}]。
    这里演示：经核心 API fs.listDir（需 fs:read:vault 权限）递归枚举 vault 文件，
    文件名/路径包含关键词即命中（真实提供者可做内容搜索，本示例保持最小）。
    结果按文件修改时间（fs.listDir 返回的 mtime，UNIX 毫秒）降序截取 limit 条：
    保证"最近修改的文件"排在前面（历史缺陷：深度优先遍历先到先得，
    新文件可能被旧文件挤出上限——搜索不到刚建的文件）。
    """
    query = (args.get("query") or "").lower()
    limit = int(args.get("limit") or 20)
    if not query:
        return []
    hits = []

    # 与宿主搜索索引相同的排除规则：隐藏目录 + 系统/依赖目录。
    # 否则 .toolbox/backups 等备份副本会被枚举出来，搜索结果出现重复噪音。
    SKIP_DIRS = {".git", ".toolbox", "node_modules", "target", "site"}

    def walk(rel):
        try:
            entries = call_core("fs.listDir", {"dir": rel})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("[py-tools] fs.listDir(%r) 失败: %s\n" % (rel, e))
            return
        for e in entries:
            if e.get("isDir"):
                if e["name"] in SKIP_DIRS or e["name"].startswith("."):
                    continue
                walk(e["path"])
            else:
                if query in e["path"].lower() or query in e["name"].lower():
                    hits.append(
                        {
                            "path": e["path"],
                            "title": e["name"],
                            "snippet": "文件名匹配（py-tools 搜索提供者）",
                            "mtime": e.get("mtime") or 0,
                        }
                    )

    walk("")
    # 最近修改优先；同时间戳保持原顺序（稳定排序）
    hits.sort(key=lambda h: h["mtime"], reverse=True)
    out = [{k: h[k] for k in ("path", "title", "snippet")} for h in hits[:limit]]
    sys.stderr.write(
        "[py-tools] search.provide query=%r hits=%d -> %d\n" % (query, len(hits), len(out))
    )
    return out


def main():
    # 协议约定 UTF-8；Windows 管道下默认 ANSI 代码页（GBK），强制 UTF-8，
    # 否则中文输出乱码、stdin 中文解析抛 UnicodeDecodeError 崩溃
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
        if msg.get("method") == "shutdown":
            break
        if "id" in msg and "method" in msg:
            sys.stdout.write(json.dumps(handle_request(msg), ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
