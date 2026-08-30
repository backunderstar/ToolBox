#!/usr/bin/env python3
"""外部插件模板：Python 进程插件骨架（JSON-RPC over stdio，NDJSON）。

协议（完整约定见 ToolBox 插件开发指南 §3 与本模板 DEVELOPER.md §3）：
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
5. 核心 API：插件在处理 call 请求期间可反向调用宿主核心 API（fs 读写/日志/通知
   等，需在 plugin.json 的 permissions 声明对应权限）——call_core() 是现成实现，
   下面 fileList / notifyDemo 两个命令演示。

本模板演示的命令：
- hello        ：普通命令（参数 + 返回值）
- eventDemo    ：边处理边推送 progress 事件
- fileList     ：核心 API fs.listDir（权限 fs:read:vault）递归列 vault 内文件
- notifyDemo   ：核心 API notify（权限 notify）→ 宿主右上角横幅
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
            result = {"commands": ["hello", "eventDemo", "fileList", "notifyDemo"]}
        elif method == "call":
            command = params.get("command", "")
            args = params.get("args") or {}
            if command == "hello":
                name = args.get("name", "")
                result = {"message": "你好%s，来自 Python 插件！" % ("，" + name if name else "")}
            elif command == "eventDemo":
                for pct in (30, 60, 100):
                    notify("progress", {"percent": pct, "message": "处理中…"})
                result = {"text": "已发送 3 个进度事件"}
            elif command == "fileList":
                result = list_vault_files()
            elif command == "notifyDemo":
                call_core(
                    "notify",
                    {"title": "模板插件", "body": "宿主右上角横幅通知（核心 API notify，权限 notify）"},
                )
                result = {"ok": True}
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
    """调用宿主核心 API（fs.readText / fs.listDir / log / notify 等，按 plugin.json
    的 permissions 放行）。

    插件 → 宿主发 {"id": N, "method": <核心 API>, "params": {...}}，宿主响应同 id。
    返回响应里的 result（错误则抛异常）。注意：必须在处理 call 请求期间调用
    （宿主在该期间会响应核心请求）。完整方法表见 DEVELOPER.md §4。
    """
    sys.stdout.write(json.dumps({"id": 9000, "method": method, "params": params}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    msg = json.loads(sys.stdin.readline())
    if "error" in msg:
        err = msg["error"]
        raise ValueError(err.get("message", "核心 API 错误"))
    return msg.get("result")


def list_vault_files():
    """演示核心 API：递归枚举 vault 内全部 .md 文件（fs.listDir，权限 fs:read:vault）。"""
    hits = []

    def walk(rel, depth):
        if depth > 12:
            return
        try:
            entries = call_core("fs.listDir", {"dir": rel})
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("[模板] fs.listDir(%r) 失败: %s\n" % (rel, e))
            return
        for e in entries:
            if e.get("isDir"):
                walk(e["path"], depth + 1)
            elif e["name"].endswith(".md"):
                hits.append(e["path"])

    walk("", 0)
    return {"count": len(hits), "files": hits[:50]}


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
