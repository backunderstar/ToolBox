//! 核心数据模型（移植自 Python `probe_layer/model.py`）。
//!
//! 单位统一为 mm（内部计算）。`ConflictGraph` 为可变结构；其余为不可变值类型。

use crate::collections::{HashMap, HashSet};

/// 二维点。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    pub fn sub(self, other: Point) -> Point {
        Point::new(self.x - other.x, self.y - other.y)
    }
    pub fn add(self, other: Point) -> Point {
        Point::new(self.x + other.x, self.y + other.y)
    }
    pub fn dist(self, other: Point) -> f64 {
        (self.x - other.x).hypot(self.y - other.y)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Units {
    Mm,
    Mil,
    Um,
}

impl Units {
    pub fn parse(s: &str) -> Units {
        match s.trim().to_lowercase().as_str() {
            "mil" => Units::Mil,
            "um" => Units::Um,
            _ => Units::Mm,
        }
    }
}

// ---------------------------------------------------------------------------
// 层叠 / 信号组 / 网络组
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct LayerDef {
    pub index: i64, // 1-based 层序号
    pub name: String,
    pub kind: String,        // "signal" | "plane"
    pub preferred_dir: String, // "H" | "V" | "any" | "-"
}

#[derive(Debug, Clone, PartialEq)]
pub struct LayerStack {
    pub layers: Vec<LayerDef>,
    pub via_kind: String, // "through" 等
}

impl LayerStack {
    pub fn signal_layers(&self) -> Vec<i64> {
        self.layers
            .iter()
            .filter(|l| l.kind == "signal")
            .map(|l| l.index)
            .collect()
    }
    pub fn plane_layers(&self) -> Vec<i64> {
        self.layers
            .iter()
            .filter(|l| l.kind == "plane")
            .map(|l| l.index)
            .collect()
    }
    pub fn kind_of(&self, index: i64) -> String {
        self.layers
            .iter()
            .find(|l| l.index == index)
            .map(|l| l.kind.clone())
            .unwrap_or_else(|| "signal".to_string())
    }
    pub fn layer_names(&self) -> HashMap<i64, String> {
        self.layers
            .iter()
            .map(|l| (l.index, l.name.clone()))
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignalGroup {
    pub group_id: String,
    pub allowed_layers: Vec<i64>,
    pub net_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NetGroup {
    pub group_id: String,
    pub kind: String,
    pub net_ids: Vec<String>,
    pub same_layer: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetClass {
    Signal,
    Power,
    Ground,
}

impl NetClass {
    pub fn parse(s: &str) -> NetClass {
        match s.trim().to_lowercase().as_str() {
            "power" => NetClass::Power,
            "ground" => NetClass::Ground,
            _ => NetClass::Signal,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            NetClass::Signal => "signal",
            NetClass::Power => "power",
            NetClass::Ground => "ground",
        }
    }
}

// ---------------------------------------------------------------------------
// 网络 / 飞线
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Pin {
    pub pin_id: String,
    pub pos: Point,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Net {
    pub net_id: String,
    pub net_class: NetClass,
    pub signal_group_id: Option<String>,
    pub net_group_id: Option<String>,
    pub pins: Vec<Pin>,
    pub width: f64,
    pub clearance: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Wire {
    pub wire_id: String,
    pub net_id: String,
    pub start: Point,
    pub end: Point,
    pub width: f64,
    pub clearance: f64,
    pub penalty: f64,
}

impl Wire {
    pub fn new(
        wire_id: String,
        net_id: String,
        start: Point,
        end: Point,
        width: f64,
        clearance: f64,
    ) -> Self {
        Self {
            wire_id,
            net_id,
            start,
            end,
            width,
            clearance,
            penalty: 0.0,
        }
    }
    pub fn length(&self) -> f64 {
        self.end.sub(self.start).dist(Point::new(0.0, 0.0))
    }
    /// 方向角归一化到 [0, 180)。
    pub fn angle_deg(&self) -> f64 {
        let a = (self.end.y - self.start.y).atan2(self.end.x - self.start.x).to_degrees();
        ((a % 180.0) + 180.0) % 180.0
    }
    /// (xmin, ymin, xmax, ymax)
    pub fn bounding_box(&self) -> (f64, f64, f64, f64) {
        (
            self.start.x.min(self.end.x),
            self.start.y.min(self.end.y),
            self.start.x.max(self.end.x),
            self.start.y.max(self.end.y),
        )
    }
}

// ---------------------------------------------------------------------------
// 禁布区
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct RectZone {
    pub zone_id: String,
    pub xmin: f64,
    pub ymin: f64,
    pub xmax: f64,
    pub ymax: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CircleZone {
    pub zone_id: String,
    pub center: Point,
    pub radius: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum KeepoutZone {
    Rect(RectZone),
    Circle(CircleZone),
}

impl KeepoutZone {
    pub fn zone_id(&self) -> &str {
        match self {
            KeepoutZone::Rect(z) => &z.zone_id,
            KeepoutZone::Circle(z) => &z.zone_id,
        }
    }
}

// ---------------------------------------------------------------------------
// 冲突模型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictLevel {
    Hard,
    Soft,
    None,
}

impl ConflictLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConflictLevel::Hard => "hard",
            ConflictLevel::Soft => "soft",
            ConflictLevel::None => "none",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Conflict {
    pub wire_a: String,
    pub wire_b: String,
    pub level: ConflictLevel,
    pub intersect_pt: Option<Point>,
    pub clearance_gap: f64,
    pub dist_to_endpoints: (f64, f64),
    pub keepout_ids: Vec<String>,
    pub congestion: f64,
    pub reasons: Vec<String>,
}

/// 硬冲突图：节点 = wire_id，边 = 硬冲突。
#[derive(Debug, Clone, Default)]
pub struct ConflictGraph {
    adjacency: HashMap<String, HashSet<String>>,
}

impl ConflictGraph {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn add_node(&mut self, a: &str) {
        self.adjacency.entry(a.to_string()).or_default();
    }
    pub fn add_edge(&mut self, a: &str, b: &str) {
        self.adjacency.entry(a.to_string()).or_default().insert(b.to_string());
        self.adjacency.entry(b.to_string()).or_default().insert(a.to_string());
    }
    pub fn has_edge(&self, a: &str, b: &str) -> bool {
        self.adjacency.get(a).map(|s| s.contains(b)).unwrap_or(false)
    }
    pub fn neighbors(&self, a: &str) -> HashSet<String> {
        self.adjacency.get(a).cloned().unwrap_or_default()
    }
    pub fn nodes(&self) -> Vec<String> {
        self.adjacency.keys().cloned().collect()
    }
    pub fn edges(&self) -> Vec<(String, String)> {
        let mut seen: HashSet<(String, String)> = HashSet::default();
        let mut out = Vec::new();
        let mut keys: Vec<&String> = self.adjacency.keys().collect();
        keys.sort();
        for a in keys {
            let mut nbs: Vec<&String> = self.adjacency[a].iter().collect();
            nbs.sort();
            for b in nbs {
                let key = if a < b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
                if !seen.contains(&key) {
                    seen.insert(key.clone());
                    out.push(key);
                }
            }
        }
        out
    }
    pub fn node_count(&self) -> usize {
        self.adjacency.len()
    }
}

// ---------------------------------------------------------------------------
// 结果模型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct LayerInfo {
    pub layer_index: i64,
    pub kind: String,
    pub signal_groups: Vec<String>,
    pub wires: Vec<String>,
    pub nets: Vec<String>,
    pub soft_conflict_count: i64,
    pub max_occupancy: f64,
    pub requires_detour: Vec<String>,
    pub requires_endpoint_via: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct LayeringResult {
    pub layers: Vec<LayerInfo>,
    pub assignment: HashMap<String, i64>, // wire_id -> layer_index
    pub plane_nets: Vec<String>,
    pub hard_conflicts: Vec<Conflict>,
    pub soft_conflicts: Vec<Conflict>,
    pub method: String,
    pub iterations_used: i64,
    pub capacity_lower_bound: HashMap<String, f64>,
    pub warnings: Vec<String>,
    pub manual_route_nets: Vec<String>,
    /// 走通率：已分配 net 中被判定为可布的数量（见 `post_process::routable_nets`）。
    pub routable_net_count: usize,
    /// 走通率：已分配 net 总数。
    pub total_net_count: usize,
    /// 走通率：被判定不可布的 net id（均来自已分配 net）。
    pub unroutable_nets: Vec<String>,
    /// 走通率（模拟路由路径版，里程碑 1）：可按"曼哈顿 L/Z 估计路径"可布的已分配 net 数。
    pub routable_path_net_count: usize,
    /// 走通率（模拟路由路径版）：被判定不可布的 net id。
    pub unroutable_nets_path: Vec<String>,
    /// 走通率（**真实可布版**，连通分量洪泛）：层内"容量内可走"连通区能贯穿该 net 全部线段的
    /// 已分配 net 数（比直线/路径占用判定更诚实，见 `post_process::routable_nets_flood`）。
    pub routable_flood_net_count: usize,
    /// 走通率（真实可布版）：被判定不可布的 net id。
    pub unroutable_nets_flood: Vec<String>,
    /// 少过孔度量：跨层（分布在 >1 层）的 net 数。
    pub multi_layer_nets: usize,
    /// 少过孔度量：估算"net 内跨层边界数"总和（≈需新增过孔数的下界；仅信号线）。
    pub via_estimate: usize,
}
