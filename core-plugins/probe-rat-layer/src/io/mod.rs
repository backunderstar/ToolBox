//! 输入数据抽象 + loader 工厂（移植自 Python `probe_layer/io/loader.py`）。

use crate::model::{KeepoutZone, LayerStack, Net, NetGroup, SignalGroup, Units, Wire};

#[derive(Debug, Clone)]
pub struct LoadedData {
    pub stack: Option<LayerStack>,
    pub signal_groups: Vec<SignalGroup>,
    pub net_groups: Vec<NetGroup>,
    pub nets: Vec<Net>,
    pub keepouts: Vec<KeepoutZone>,
    pub wires: Vec<Wire>,
    pub units: Units,
    pub warnings: Vec<String>,
}

impl LoadedData {
    pub fn new(warnings: Vec<String>) -> Self {
        Self {
            stack: None,
            signal_groups: Vec::new(),
            net_groups: Vec::new(),
            nets: Vec::new(),
            keepouts: Vec::new(),
            wires: Vec::new(),
            units: Units::Mm,
            warnings,
        }
    }
}

/// 按扩展名选 loader。
pub fn load_input(
    path: &str,
    filter_path: Option<&str>,
    n_signal_layers: i64,
    width: f64,
    clearance: f64,
) -> Result<LoadedData, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".xlsx") || lower.ends_with(".xls") {
        xlsx::load_xlsx(path, filter_path, n_signal_layers, width, clearance)
    } else {
        if filter_path.is_some() {
            return Err("筛选文件仅用于 .xls/.xlsx 输入".to_string());
        }
        allegro_json::load_allegro_json(path)
    }
}

mod allegro_json;
mod wire_gen;
pub(crate) mod xlsx;
