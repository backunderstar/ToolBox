"""LayeringConfig 参数模型 + JSON 加载。"""
from __future__ import annotations

import dataclasses
import json
import warnings
from dataclasses import dataclass


@dataclass(frozen=True)
class LayeringConfig:
    # —— 分层方法（可切换，便于 A/B 验证）——
    method: str = "packing"           # "packing"（默认）| "dsatur"
    sector_angle_deg: float = 45.0
    same_net_same_layer: bool = False
    # —— 迭代参数（各启发式轮数，可调效果/耗时）——
    resolve_conflict_rounds: int = 8      # 同层硬冲突微调轮数
    balance_length_rounds: int = 3        # 长短均衡交换轮数
    minimize_crossings_passes: int = 3    # 贪心交叉最小化轮数（每轮扫所有软冲突对）
    sa_restarts: int = 1                  # SA 多起点次数（>1 时多次退火取最优）
    # —— 精修优化器（packing 之后的多目标精修）——
    optimizer: str = "sa"             # "sa"（模拟退火）| "greedy" | "none"
    sa_seed: int = 42
    sa_initial_temp: float = 8.0      # 初始温度（软冲突对数尺度）
    sa_cooling: float = 0.9995        # 每步降温系数（慢降温，探索充分）
    sa_max_steps: int = 0             # 0 = 自动（max(4000, 30×线数)）
    sa_swap_ratio: float = 0.7        # 交换移动占比（其余为单线移动）
    sa_balance_slack: float = 2.0     # 均衡护栏：允许恶化到初始值的倍数
    # —— 拥塞估计 ——
    congestion_grid_cell: float = 0.5  # 拥塞网格尺寸 mm（绕行邻域，≈ 数个走线节距）
    congestion_demand_factor: float = 1.0
    congestion_hard_threshold: float = 0.8   # 交点拥塞超过此值判硬冲突（可放宽，因走线可弯折）
    layer_capacity: float = 1.0               # 每层 occupancy 上限（布线容量，满=1.0，不应>1）
    capacity_utilization: float = 0.6
    via_area_cost: float = 0.1
    pin_density_weight: float = 1.0
    # —— 端点容忍（仅报告）——
    r_end: float = 0.5
    # —— 禁布区 ——
    keepout_enabled: bool = True
    keepout_margin_factor: float = 0.5
    # —— 平面/电源地 ——
    plane_nets_excluded: bool = True
    # —— Allegro 反馈闭环 ——
    feedback_enabled: bool = True
    max_loop_iterations: int = 3
    incremental_repair: bool = True
    # —— 输出 ——
    out_dir: str = "out"
    units_out: str = "mm"
    render_png: bool = True
    render_congestion: bool = False

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)


def default_config() -> LayeringConfig:
    return LayeringConfig()


def load_config(path: str) -> LayeringConfig:
    """读取 JSON 配置；未知字段告警并忽略。"""
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    known = {fld.name for fld in dataclasses.fields(LayeringConfig)}
    unknown = set(raw) - known
    if unknown:
        warnings.warn(f"配置含未知字段，已忽略: {sorted(unknown)}")
    filtered = {k: v for k, v in raw.items() if k in known}
    return LayeringConfig(**filtered)
