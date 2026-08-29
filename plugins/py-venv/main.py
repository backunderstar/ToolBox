#!/usr/bin/env python3
"""py-venv：方案 C「插件内 venv」示例插件（JSON-RPC over stdio，NDJSON）。

演示要点（见 docs/插件开发指南.md §3.5 方案 C）：
- plugin.json 的 command 直接用 `<插件>/.venv/Scripts/python.exe`（Windows）——
  解释器是 venv 自带的，不参与宿主的三级解析，依赖完全隔离在 .venv 里。
- 目录较大（venv 本体 + 依赖），首次需创建；适合依赖多且版本敏感的插件。
- .venv 不入库（.gitignore 已忽略），在目标机/构建机创建后插件即自包含。

创建 .venv（用捆绑运行时创建，保证与随包解释器一致）：
    <捆绑 python.exe> -m venv .venv
    .venv\\Scripts\\pip install <依赖包>   # 有第三方依赖时
（venv 方案的依赖装进 .venv 而非 vendor/，故不声明 requirements.txt，
避免「安装依赖」按钮把依赖装到错误位置。）

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
            result = {"commands": ["venv.info"]}
        elif method == "call":
            command = params.get("command", "")
            if command == "venv.info":
                import sysconfig
                result = {
                    "python": sys.executable,
                    "prefix": sys.prefix,
                    "stdlib": sysconfig.get_paths().get("stdlib"),
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
