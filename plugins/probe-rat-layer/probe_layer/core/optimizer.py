"""模拟退火分层精修：以软冲突（交叉）为单一优化目标，均衡作为护栏。

方法 B（packing）先用扇区轮询给出一个数量/长短/扇区都均衡的初始解，
本模块在其上精修，目标只有一个：**最小化同层软冲突（交叉）对数**。

- 硬冲突是硬约束：任何移动都禁止产生同层硬冲突；
- 数量/长短/扇区均衡是**护栏**（guardrail），而非加权目标：移动后若某项
  不均衡度超过「初始值 × slack」就被拒绝。护栏只阻止把初始的均衡彻底
  破坏，不会反过来与"减少交叉"这个主目标抢权重（避免多目标加权调参）。
- 按 Metropolis 准则接受暂时变差的移动，跳出贪心局部最优（比纯贪心
  minimize_crossings 更彻底）。

用户偏好：分层效果优先、速度次之 → 默认较长退火链 + 固定随机种子（可复现）。
圆心固定 (0,0)；扇区均衡只统计实际有线经过的扇区（见 core/metrics.py）。
"""
from __future__ import annotations

import math
import random
from collections import Counter, defaultdict

from ..model import Wire, ConflictGraph
from ..config import LayeringConfig
from ..cancel import check_cancel
from . import metrics
from .layer_packing import wire_dir_angle


def _accept(cur_soft: int, new_soft: int, T: float, rng: random.Random) -> bool:
    """Metropolis 接受准则（能量 = 软冲突原始对数，越小越好）。"""
    if new_soft <= cur_soft:
        return True
    if T <= 0:
        return False
    return rng.random() < math.exp(-(new_soft - cur_soft) / T)


def optimize_layering(assignment: dict[str, int],
                      wires: tuple[Wire, ...],
                      soft_pairs: list[tuple[str, str]],
                      hard_graph: ConflictGraph,
                      allowed: dict[str, set[int]],
                      cfg: LayeringConfig,
                      rng: random.Random | None = None,
                      on_progress=None,
                      cancel_event=None) -> dict[str, int]:
    """在 assignment 上做模拟退火，返回（更优或等价的）分层。

    只移动当前已分配的线，不改变"哪些线被分配"。
    """
    if not assignment:
        return assignment
    rng = rng or random.Random(cfg.sa_seed)
    layers = sorted({l for s in allowed.values() for l in s})
    if len(layers) < 2:
        return assignment

    wire_by_id = {w.wire_id: w for w in wires}

    def sec(w: Wire) -> int:
        return metrics.sector_index(wire_dir_angle(w), cfg.sector_angle_deg)

    # 只保留两端都已分配的软冲突对（交叉）
    pairs = [(a, b) for a, b in soft_pairs
             if a in assignment and b in assignment]
    soft_adj: dict[str, set[str]] = defaultdict(set)
    for a, b in pairs:
        soft_adj[a].add(b)
        soft_adj[b].add(a)

    # 层结构：线集合 / 总长 / 扇区计数
    layer_wires: dict[int, set[str]] = {l: set() for l in layers}
    layer_len: dict[int, float] = {l: 0.0 for l in layers}
    layer_sector: dict[int, Counter] = {l: Counter() for l in layers}
    for wid, l in assignment.items():
        layer_wires[l].add(wid)
        w = wire_by_id[wid]
        layer_len[l] += w.length
        layer_sector[l][sec(w)] += 1

    soft_total = metrics.soft_crossings(assignment, pairs)
    lc = {l: len(layer_wires[l]) for l in layers}

    def imbalances() -> tuple[float, float, float]:
        n = sum(lc.values())
        return (metrics.count_imbalance(lc),
                metrics.length_imbalance(layer_len, lc),
                metrics.sector_imbalance(layer_sector, n))

    base = imbalances()          # 初始（轮询）均衡度，护栏基准
    slack = cfg.sa_balance_slack

    def within_guardrail() -> bool:
        c, ln, s = imbalances()
        return (c <= max(base[0], 1e-6) * slack
                and ln <= max(base[1], 1e-6) * slack
                and s <= max(base[2], 1e-6) * slack)

    def hard_conflict_in(wid: str, l: int, exclude: str | None = None) -> bool:
        for x in layer_wires[l]:
            if x != exclude and hard_graph.has_edge(wid, x):
                return True
        return False

    def soft_in(wid: str, l: int, exclude: str | None = None) -> int:
        return sum(1 for x in soft_adj[wid]
                   if x in layer_wires[l] and x != exclude)

    def _try_swap(a: str, la: int, b: str, lb: int) -> bool:
        nonlocal soft_total
        if hard_conflict_in(a, lb, b) or hard_conflict_in(b, la, a):
            return False
        d_soft = (soft_in(a, lb, b) + soft_in(b, la, a)
                  - soft_in(a, la) - soft_in(b, lb))
        wa, wb = wire_by_id[a], wire_by_id[b]
        sa = sec(wa)
        sb = sec(wb)

        # 试探性更新长度/扇区（数量不变）
        layer_len[la] += wb.length - wa.length
        layer_len[lb] += wa.length - wb.length
        layer_sector[la][sa] -= 1
        layer_sector[lb][sb] -= 1
        layer_sector[la][sb] += 1
        layer_sector[lb][sa] += 1

        if not within_guardrail() or not _accept(soft_total, soft_total + d_soft, T, rng):
            layer_len[la] += wa.length - wb.length
            layer_len[lb] += wb.length - wa.length
            layer_sector[la][sa] += 1
            layer_sector[lb][sb] += 1
            layer_sector[la][sb] -= 1
            layer_sector[lb][sa] -= 1
            return False

        layer_wires[la].discard(a)
        layer_wires[lb].add(a)
        layer_wires[lb].discard(b)
        layer_wires[la].add(b)
        assignment[a] = lb
        assignment[b] = la
        soft_total += d_soft
        return True

    def _try_move(w: str) -> bool:
        nonlocal soft_total
        la = assignment[w]
        cands = [l for l in allowed.get(w, ()) if l != la]
        if not cands:
            return False
        lb = rng.choice(cands)
        if hard_conflict_in(w, lb):
            return False
        d_soft = soft_in(w, lb) - soft_in(w, la)
        ww = wire_by_id[w]
        si = sec(ww)

        layer_len[la] -= ww.length
        layer_len[lb] += ww.length
        layer_sector[la][si] -= 1
        layer_sector[lb][si] += 1
        lc[la] -= 1
        lc[lb] += 1

        if not within_guardrail() or not _accept(soft_total, soft_total + d_soft, T, rng):
            layer_len[la] += ww.length
            layer_len[lb] -= ww.length
            layer_sector[la][si] += 1
            layer_sector[lb][si] -= 1
            lc[la] += 1
            lc[lb] -= 1
            return False

        layer_wires[la].discard(w)
        layer_wires[lb].add(w)
        assignment[w] = lb
        soft_total += d_soft
        return True

    best_soft = soft_total
    best_assignment = dict(assignment)
    steps = cfg.sa_max_steps or max(4000, 30 * len(assignment))
    T = cfg.sa_initial_temp
    alpha = cfg.sa_cooling
    ids = list(assignment.keys())
    # 进度回调节流：每 ~2% 步数回调一次（避免高频 IPC）
    progress_every = max(1, steps // 50)

    for i in range(steps):
        if i % progress_every == 0:
            if on_progress:
                on_progress(i / steps)
            check_cancel(cancel_event)
        moved = False
        # 优先用软冲突对做跨层交换（保持数量不变）
        if pairs and rng.random() < cfg.sa_swap_ratio:
            a, b = rng.choice(pairs)
            la, lb = assignment.get(a), assignment.get(b)
            if la is not None and lb is not None and la != lb:
                moved = _try_swap(a, la, b, lb)
        # 否则（或无软冲突对）单线移动（可微调数量，护栏约束）
        if not moved:
            moved = _try_move(rng.choice(ids))

        if moved and soft_total < best_soft:
            best_soft = soft_total
            best_assignment = dict(assignment)

        T *= alpha
        if T < 1e-12:
            break

    return best_assignment
