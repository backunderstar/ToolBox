//! `LayeringConfig` 参数模型 + JSON 加载（移植自 Python `probe_layer/config.py`）。
//!
//! 未知字段忽略（serde 默认），数值字段统一 f64（UI 传 `2` 而非 `2.0` 也能读）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LayeringConfig {
    pub method: String,          // "packing" | "dsatur"
    pub sector_angle_deg: f64,
    pub same_net_same_layer: bool,
    /// 同 net 尽量同层的软偏好强度 λ：>0 时启用"先整网、放不下按段拆"的两级决策
    /// （里程碑 0）；λ=0 完全按段（现状）。0 为完全按段，越大越偏向整网同层（少过孔）。
    pub same_net_via_penalty: f64,
    // —— 迭代参数 ——
    pub resolve_conflict_rounds: i64,
    pub balance_length_rounds: i64,
    pub minimize_crossings_passes: i64,
    pub sa_restarts: i64,
    // —— 精修优化器 ——
    pub optimizer: String,       // "sa" | "greedy" | "none"
    pub sa_seed: u64,
    pub sa_initial_temp: f64,
    pub sa_cooling: f64,
    pub sa_max_steps: i64,       // 0 = 自动
    pub sa_swap_ratio: f64,
    pub sa_balance_slack: f64,
    /// 后处理：分层后按拥塞（每格点占用 = demand/supply）把超容层/格点上的线平衡到低拥塞允许层。
    /// 默认 false = 关闭（保留现有结果）；开启可把圆心/内枢占用峰值摊平、减少需人工/硬冲突。
    pub congestion_balance: bool,
    /// 后处理"拥塞均衡"最大轮数（每轮做一轮正收益的贪心移动；顺序读取，一轮只做一次判断）。
    pub congestion_balance_passes: i64,
    // —— 拥塞估计 ——
    pub congestion_grid_cell: f64,
    pub congestion_demand_factor: f64,
    pub congestion_hard_threshold: f64,
    pub layer_capacity: f64,
    pub capacity_utilization: f64,
    pub via_area_cost: f64,
    pub pin_density_weight: f64,
    /// 里程碑 2：拥塞平滑代价指数 k（Σ(occupancy)^k）；>0 时启用平滑拥塞代价（默认 2.0，未启用时不生效）。
    pub congestion_k: f64,
    /// 里程碑 2：整网 rip-up-and-reroute 迭代轮数；>0 启用（默认 0=关闭，保留现有行为）。
    pub ripup_rounds: i64,
    // —— 端点容忍（仅报告）——
    pub r_end: f64,
    /// 短线容忍：长度 ≤ 该值(mm)的段视为"短线"。0 = 不启用短线容忍（默认=现状，不做特殊处理）。
    pub short_segment_len: f64,
    /// 短线交叉的硬冲突阈值放大系数：任一段为短线时，交点拥塞需 ≥ congestion_hard_threshold ×
    /// 本系数才判硬冲突，否则按软处理。1.0 = 不放大（默认=现状）；>1 时短线交叉更易判软（更宽容）。
    pub short_segment_crossing_factor: f64,
    // —— 禁布区 ——
    pub keepout_enabled: bool,
    pub keepout_margin_factor: f64,
    // —— 平面/电源地 ——
    pub plane_nets_excluded: bool,
    // —— Allegro 反馈闭环 ——
    pub feedback_enabled: bool,
    pub max_loop_iterations: i64,
    pub incremental_repair: bool,
    // —— 输出 ——
    pub out_dir: String,
    pub units_out: String,
    pub render_png: bool,
    pub render_congestion: bool,
}

impl Default for LayeringConfig {
    fn default() -> Self {
        Self {
            method: "packing".into(),
            sector_angle_deg: 45.0,
            same_net_same_layer: false,
            same_net_via_penalty: 0.0,
            resolve_conflict_rounds: 8,
            balance_length_rounds: 3,
            minimize_crossings_passes: 3,
            sa_restarts: 1,
            optimizer: "sa".into(),
            sa_seed: 42,
            sa_initial_temp: 8.0,
            sa_cooling: 0.9995,
            sa_max_steps: 0,
            sa_swap_ratio: 0.7,
            sa_balance_slack: 2.0,
            congestion_balance: false,
            congestion_balance_passes: 20,
            congestion_grid_cell: 0.5,
            congestion_demand_factor: 1.0,
            congestion_hard_threshold: 0.8,
            layer_capacity: 1.0,
            capacity_utilization: 0.6,
            via_area_cost: 0.1,
            pin_density_weight: 1.0,
            congestion_k: 2.0,
            ripup_rounds: 0,
            r_end: 0.5,
            short_segment_len: 0.0,
            short_segment_crossing_factor: 1.0,
            keepout_enabled: true,
            keepout_margin_factor: 0.5,
            plane_nets_excluded: true,
            feedback_enabled: true,
            max_loop_iterations: 3,
            incremental_repair: true,
            out_dir: "out".into(),
            units_out: "mm".into(),
            render_png: true,
            render_congestion: false,
        }
    }
}

impl LayeringConfig {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }

    /// 从 JSON 覆盖值合并进默认配置；仅认已知字段，未知忽略。
    /// 数值在 `Config` 里即 f64，来自 UI 的 int 由 serde_json 自动转换。
    pub fn with_overrides(mut self, overrides: &serde_json::Value) -> Result<Self, String> {
        let Some(obj) = overrides.as_object() else {
            return Ok(self);
        };
        let known = serde_json::to_value(&self)
            .ok()
            .and_then(|v| v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()))
            .unwrap_or_default();
        for (k, v) in obj {
            if !known.iter().any(|kk| kk == k) {
                continue; // 未知字段忽略
            }
            self.apply_field(k, v)?;
        }
        Ok(self)
    }

    fn apply_field(&mut self, k: &str, v: &serde_json::Value) -> Result<(), String> {
        let s = |v: &serde_json::Value| v.as_str().map(str::to_string).ok_or_else(|| format!("字段 {k} 应为字符串"));
        let f = |v: &serde_json::Value| v.as_f64().ok_or_else(|| format!("字段 {k} 应为数字"));
        let i = |v: &serde_json::Value| v.as_i64().ok_or_else(|| format!("字段 {k} 应为整数"));
        let b = |v: &serde_json::Value| v.as_bool().ok_or_else(|| format!("字段 {k} 应为布尔"));
        match k {
            "method" => self.method = s(v)?,
            "optimizer" => self.optimizer = s(v)?,
            "units_out" => self.units_out = s(v)?,
            "out_dir" => self.out_dir = s(v)?,
            "sector_angle_deg" => self.sector_angle_deg = f(v)?,
            "sa_initial_temp" => self.sa_initial_temp = f(v)?,
            "sa_cooling" => self.sa_cooling = f(v)?,
            "sa_swap_ratio" => self.sa_swap_ratio = f(v)?,
            "sa_balance_slack" => self.sa_balance_slack = f(v)?,
            "congestion_balance" => self.congestion_balance = b(v)?,
            "congestion_balance_passes" => self.congestion_balance_passes = i(v)?,
            "congestion_grid_cell" => self.congestion_grid_cell = f(v)?,
            "congestion_demand_factor" => self.congestion_demand_factor = f(v)?,
            "congestion_hard_threshold" => self.congestion_hard_threshold = f(v)?,
            "layer_capacity" => self.layer_capacity = f(v)?,
            "capacity_utilization" => self.capacity_utilization = f(v)?,
            "via_area_cost" => self.via_area_cost = f(v)?,
            "pin_density_weight" => self.pin_density_weight = f(v)?,
            "congestion_k" => self.congestion_k = f(v)?,
            "ripup_rounds" => self.ripup_rounds = i(v)?,
            "r_end" => self.r_end = f(v)?,
            "short_segment_len" => self.short_segment_len = f(v)?,
            "short_segment_crossing_factor" => self.short_segment_crossing_factor = f(v)?,
            "keepout_margin_factor" => self.keepout_margin_factor = f(v)?,
            "resolve_conflict_rounds" => self.resolve_conflict_rounds = i(v)?,
            "balance_length_rounds" => self.balance_length_rounds = i(v)?,
            "minimize_crossings_passes" => self.minimize_crossings_passes = i(v)?,
            "sa_restarts" => self.sa_restarts = i(v)?,
            "sa_max_steps" => self.sa_max_steps = i(v)?,
            "max_loop_iterations" => self.max_loop_iterations = i(v)?,
            "sa_seed" => self.sa_seed = v.as_u64().unwrap_or(42),
            "same_net_same_layer" => self.same_net_same_layer = b(v)?,
            "same_net_via_penalty" => self.same_net_via_penalty = f(v)?,
            "keepout_enabled" => self.keepout_enabled = b(v)?,
            "plane_nets_excluded" => self.plane_nets_excluded = b(v)?,
            "feedback_enabled" => self.feedback_enabled = b(v)?,
            "incremental_repair" => self.incremental_repair = b(v)?,
            "render_png" => self.render_png = b(v)?,
            "render_congestion" => self.render_congestion = b(v)?,
            _ => {}
        }
        Ok(())
    }
}

pub fn default_config() -> LayeringConfig {
    LayeringConfig::default()
}
