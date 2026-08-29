#!/usr/bin/env python3
"""py-env：方案 B「自带 site-packages」示例插件（JSON-RPC over stdio，NDJSON）。

演示要点（见 docs/插件开发指南.md §3.5 方案 B）：
- 第三方库装进 <插件>/env/（`pip install --target env <包>`），与 vendor/ 不同：
  env 面向**二进制 wheel**（pandas、regex 这类带 C 扩展的包）。
- 启动时把 env/ 插进 sys.path，插件即自包含。
- ⚠️ wheel 的 ABI 必须匹配解释器版本：本插件依赖的 regex 装的是 cp314
  win_amd64 wheel（捆绑运行时 = Python 3.14.7 Windows x86_64）。

安装依赖（env/ 不是按钮默认的 vendor/ 目标，故不声明 requirements.txt，
避免「安装依赖」按钮把依赖装错位置）：
    <捆绑 python.exe> -m pip install --target env regex

本示例用 `regex`（regex 模块，含 C 扩展；re 没有的模糊匹配等高级特性）。
协议：见 docs/插件开发指南.md §3（与 csv-tool / py-tools 一致）。
"""
import json
import os
import sys

# 方案 B：env/（site-packages 形式）插进 sys.path
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "env"))

import regex  # noqa: E402  第三方库（带 C 扩展的 wheel）


def handle_request(msg):
    """处理宿主请求（init / call），返回带 id 的响应。"""
    mid = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params") or {}
    try:
        if method == "init":
            result = {"commands": ["env.match", "env.info"]}
        elif method == "call":
            command = params.get("command", "")
            args = params.get("args") or {}
            if command == "env.match":
                # 模糊匹配（re 模块没有的能力，regex 的 {e<=N} 语法）
                pattern = args.get("pattern", "")
                text = args.get("text", "")
                m = regex.search(pattern, text)
                result = {"matched": bool(m), "text": m.group(0) if m else None}
            elif command == "env.info":
                # 回显解释器与模块来源，便于确认用的是捆绑解释器 + env 里的库
                import regex as _r
                result = {
                    "python": sys.executable,
                    "prefix": sys.prefix,
                    "regex_file": _r.__file__,
                }
            else:
                raise ValueError("未知命令: %s" % command)
        else:
            raise ValueError("未知方法: %s" % method)
        return {"id": mid, "result": result}
    except Exception as e:  # noqa: BLE001
        return {"id": mid, "error": {"code": -32000, "message": str(e)}}


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
