#!/usr/bin/env python3
"""py-files：核心 API 调用示例插件（JSON-RPC over stdio，NDJSON）。

演示要点：
1. 核心 API（见 docs/插件开发指南.md §3.3）：插件可经宿主转发调用
   fs.readText / fs.writeText / fs.listDir / log——按 plugin.json 的
   permissions 门控（本插件声明了 fs:read:vault / fs:write:vault / log）。
   调用只在处理宿主请求期间有效（宿主在该期间才会响应核心 API 请求）。
2. UTF-8：Windows 管道默认 ANSI 代码页（GBK），必须 reconfigure 成 UTF-8，
   否则中文 JSON 乱码/崩溃。
3. 命令白名单：init 握手声明，未声明的命令宿主拒绝调用。

协议：见 docs/插件开发指南.md §3（与 csv-tool / py-tools 一致）。
"""
import json
import sys


def handle_request(msg):
    """处理宿主请求（init / call），返回带 id 的响应。"""
    mid = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") or {}
    try:
        if method == "init":
            result = {"commands": ["files.hello", "files.list", "files.read", "files.append", "files.log"]}
        elif method == "call":
            command = params.get("command", "")
            args = params.get("args") or {}
            if command == "files.hello":
                # 中文往返：验证 UTF-8 管道
                result = {"text": "你好，%s！" % args.get("name", "世界")}
            elif command == "files.list":
                entries = call_core("fs.listDir", {"dir": args.get("dir", "")})
                result = {
                    "total": len(entries),
                    "names": [e.get("name") for e in entries[:20]],
                }
            elif command == "files.read":
                content = call_core("fs.readText", {"path": args.get("path", "")})
                result = {"content": content}
            elif command == "files.append":
                # 追加写：读原内容 + 新内容写回（vault 相对路径，`..`/绝对路径被宿主拒绝）
                path = args.get("path", "")
                old = call_core("fs.readText", {"path": path}) or ""
                new = old.rstrip("\n") + "\n" + args.get("content", "") + "\n"
                call_core("fs.writeText", {"path": path, "content": new})
                result = {"ok": True, "length": len(new)}
            elif command == "files.log":
                call_core("log", {"message": "py-files: " + str(args.get("text", ""))})
                result = {"ok": True}
            else:
                raise ValueError("未知命令: %s" % command)
        else:
            raise ValueError("未知方法: %s" % method)
        return {"id": mid, "result": result}
    except Exception as e:  # noqa: BLE001
        return {"id": mid, "error": {"code": -32000, "message": str(e)}}


def call_core(method, params):
    """调用核心 API（按 plugin.json 的 permissions 放行）。
    只能在处理宿主请求期间调用。"""
    sys.stdout.write(json.dumps({"id": 9000, "method": method, "params": params}, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    msg = json.loads(sys.stdin.readline())
    if "error" in msg:
        raise ValueError(msg["error"].get("message", "核心 API 错误"))
    return msg.get("result")


def main():
    # Windows 管道强制 UTF-8（否则中文 JSON 乱码）
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
