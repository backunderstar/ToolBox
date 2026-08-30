"""进度/取消钩子支持（ToolBox 插件用；CLI/原项目不受影响）。

插件需要把 probe_layer 跑在后台线程（宿主 30s 调用超时），并给用户进度与取消能力。
本模块提供两个可选接线点，全部默认关闭（传 None 即完全原行为）：

- `on_progress(percent, message)`：0~100 的浮点进度 + 阶段文案；
- `cancel_event`：带 `is_set() -> bool` 的对象（如 `threading.Event`），置位后
  在循环边界抛出 `LayeringCancelled`，调用方捕获后按"取消"处理。
"""
from __future__ import annotations


class LayeringCancelled(Exception):
    """分层过程被用户取消。"""


def check_cancel(cancel_event) -> None:
    """在循环边界调用：已取消则抛 LayeringCancelled。"""
    if cancel_event is not None and cancel_event.is_set():
        raise LayeringCancelled("分层已取消")
