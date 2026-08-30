"""Allegro 闭环：生成 Skill 布线脚本 + 解析未布通/DRC 反馈。"""
from __future__ import annotations

import json
from dataclasses import dataclass

from ..model import LayerStack


@dataclass(frozen=True)
class LayerRouteResult:
    layer_index: int
    unrouted_wires: tuple[str, ...] = ()
    drc_errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class RoutingFeedback:
    iteration: int
    layer_results: tuple[LayerRouteResult, ...] = ()

    def unrouted_all(self) -> set[str]:
        out: set[str] = set()
        for r in self.layer_results:
            out.update(r.unrouted_wires)
        return out


def generate_skill_script(layer_nets: dict[int, list[str]],
                          stack: LayerStack | None, out_path: str) -> None:
    """生成占位 Skill 脚本（模板随真实 Allegro 环境校准，待定项 #9）。"""
    lines = [
        "; probe_layer generated Skill script (placeholder)",
        "; 真实环境请替换为 axlDB / 布线引擎调用",
        "; 1) 清空布线",
        "; 2) 逐层设置 etch layer 约束",
        "; 3) 仅对指定 nets 自动布线",
        "; 4) 写出未布通 / DRC 清单到 feedback.json",
        "",
    ]
    names = stack.layer_names() if stack else {}
    for layer in sorted(layer_nets):
        nets = layer_nets[layer]
        name = names.get(layer, f"L{layer}")
        lines.append(f"; ---- Layer {layer} ({name}) ----")
        lines.append(f"; nets = {json.dumps(nets)}")
        lines.append(f"; axlSetRouteLayer({layer})   ; 占位：设置当前路由层")
        lines.append(f"; axlAutoRoute({json.dumps(nets)})  ; 占位：布线指定 nets")
        lines.append("")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


def parse_route_feedback(feedback_path: str) -> RoutingFeedback:
    with open(feedback_path, encoding="utf-8") as f:
        d = json.load(f)
    results = tuple(
        LayerRouteResult(int(r["layer"]),
                         tuple(r.get("unrouted_wires", [])),
                         tuple(r.get("drc_errors", [])))
        for r in d.get("layers", []))
    return RoutingFeedback(int(d.get("iteration", 0)), results)
