//! Allegro pin 表 loader（xls/xlsx，calamine 替代 openpyxl+xlrd）+ 筛选文件。
//! 移植自 Python `probe_layer/io/xlsx_loader.py`。

use crate::io::LoadedData;
use crate::io::wire_gen::generate_wires;
use crate::model::{LayerDef, LayerStack, Net, NetClass, Pin, Point, SignalGroup, Units};
use calamine::{Data, Reader};
use std::collections::HashMap;

// 列名别名：表头（小写）→ 规范列名
fn _col_aliases() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::new();
    for (k, v) in [
        ("net", "net_name"), ("net_name", "net_name"), ("network", "net_name"), ("网络", "net_name"),
        ("pin_x", "pin_x"), ("x", "pin_x"), ("x坐标", "pin_x"),
        ("pin_y", "pin_y"), ("y", "pin_y"), ("y坐标", "pin_y"),
        ("refdes", "refdes"), ("reference", "refdes"), ("位号", "refdes"),
        ("pin_number", "pin_number"), ("pin", "pin_number"), ("引脚", "pin_number"),
    ] {
        m.insert(k, v);
    }
    m
}

fn _cell_str(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::Float(f) => {
            if f.fract() == 0.0 {
                (*f as i64).to_string()
            } else {
                f.to_string()
            }
        }
        Data::Int(i) => i.to_string(),
        Data::String(s) => s.trim().to_string(),
        Data::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

fn _cell_f64(cell: &Data) -> Option<f64> {
    match cell {
        Data::Float(f) => Some(*f),
        Data::Int(i) => Some(*i as f64),
        other => _cell_str(other).parse::<f64>().ok(),
    }
}

/// 逐行 yield xls/xlsx 表格内容（转成字符串行）。
fn _read_rows(path: &str) -> Result<Vec<Vec<String>>, String> {
    let mut wb = calamine::open_workbook_auto(path).map_err(|e| format!("打开表格失败: {e}"))?;
    let names = wb.sheet_names().to_vec();
    if names.is_empty() {
        return Err("表格无工作表".to_string());
    }
    let range = wb
        .worksheet_range(&names[0])
        .map_err(|e| format!("读取工作表失败: {e}"))?;
    let mut out = Vec::new();
    for row in range.rows() {
        out.push(row.iter().map(_cell_str).collect());
    }
    Ok(out)
}

pub fn classify_net(name: &str) -> Option<NetClass> {
    let u = name.to_uppercase().trim().to_string();
    if u == "NC" {
        return None;
    }
    for k in ["GND", "VSS", "AGND", "DGND", "SGND", "GROUND"] {
        if u.contains(k) {
            return Some(NetClass::Ground);
        }
    }
    for k in ["VDD", "VCC", "VPP", "VREF", "AVDD", "DVDD", "PWR"] {
        if u.contains(k) {
            return Some(NetClass::Power);
        }
    }
    // re.search(r"V\d", u)
    if _vdigit(&u) {
        return Some(NetClass::Power);
    }
    Some(NetClass::Signal)
}

fn _vdigit(u: &str) -> bool {
    // 与 Python `re.search(r"V\d", u)` 一致：V 后**紧邻**一个数字才算电源（如 5V、V1）；
    // 不能是"V 后任意位置出现数字"——否则 HV_1 这类探针卡信号网会被误判为电源。
    u.as_bytes()
        .windows(2)
        .any(|w| w[0] == b'V' && w[1].is_ascii_digit())
}

fn _read_text_net_list(path: &str) -> Result<std::collections::HashSet<String>, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("读取筛选文件失败: {e}"))?;
    let mut names = std::collections::HashSet::new();
    for line in content.lines() {
        let v = line.trim();
        if v.is_empty() || v.starts_with('#') {
            continue;
        }
        names.insert(v.to_string());
    }
    Ok(names)
}

fn _read_net_whitelist_table(path: &str) -> Result<std::collections::HashSet<String>, String> {
    let rows = _read_rows(path)?;
    let mut names = std::collections::HashSet::new();
    for row in &rows {
        if row.is_empty() {
            continue;
        }
        let v = row[0].trim().to_string();
        if v.is_empty() {
            continue;
        }
        if ["net", "net_name", "netname", "network", "名称", "网络", "net list"].contains(&v.to_lowercase().as_str()) {
            continue;
        }
        names.insert(v);
    }
    Ok(names)
}

/// 读筛选文件：.lst/.txt 按文本（一行一个 net）；.xls/.xlsx 按表格第一列。
pub fn read_net_filter(path: &str) -> Result<std::collections::HashSet<String>, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".lst") || lower.ends_with(".txt") {
        _read_text_net_list(path)
    } else {
        _read_net_whitelist_table(path)
    }
}

fn _columns(header_row: &[String]) -> (usize, usize, usize, Option<usize>, Option<usize>) {
    let aliases = _col_aliases();
    let mut col: HashMap<String, usize> = HashMap::new();
    for (i, cell) in header_row.iter().enumerate() {
        if let Some(canonical) = aliases.get(cell.trim().to_lowercase().as_str()) {
            if !col.contains_key(*canonical) {
                col.insert(canonical.to_string(), i);
            }
        }
    }
    if col.contains_key("net_name") && col.contains_key("pin_x") && col.contains_key("pin_y") {
        return (
            col["net_name"],
            col["pin_x"],
            col["pin_y"],
            col.get("refdes").copied(),
            col.get("pin_number").copied(),
        );
    }
    // 无表头 / 表头不识别 → 按 Allegro 导出固定列序
    (7, 5, 6, Some(0), Some(1))
}

pub fn load_xlsx(
    path: &str,
    filter_path: Option<&str>,
    n_signal_layers: i64,
    width: f64,
    clearance: f64,
) -> Result<LoadedData, String> {
    let mut warnings: Vec<String> = Vec::new();
    let whitelist = match filter_path {
        Some(p) => Some(read_net_filter(p)?),
        None => None,
    };
    let rows = _read_rows(path)?;
    if rows.is_empty() {
        return Err("表格为空: {path}".to_string());
    }
    let (net_i, x_i, y_i, ref_i, pin_i) = _columns(&rows[0]);

    let mut net_pins: HashMap<String, Vec<Pin>> = HashMap::new();
    let mut counter: HashMap<String, i64> = HashMap::new();
    for row in &rows[1..] {
        if row.len() <= net_i.max(x_i).max(y_i) {
            continue;
        }
        let net = row[net_i].trim().to_string();
        if net.is_empty() {
            continue;
        }
        let (Some(x), Some(y)) = (_cell_f64_str(&row[x_i]), _cell_f64_str(&row[y_i])) else {
            continue;
        };
        let refdes = if let Some(r) = ref_i {
            if r < row.len() { row[r].trim().to_string() } else { String::new() }
        } else {
            String::new()
        };
        let pin = if let Some(p) = pin_i {
            if p < row.len() { row[p].trim().to_string() } else { String::new() }
        } else {
            String::new()
        };
        let pid = if !refdes.is_empty() && !pin.is_empty() {
            format!("{refdes}.{pin}")
        } else {
            let c = counter.entry(net.clone()).or_insert(0);
            let id = *c;
            *c += 1;
            format!("{net}.{id}")
        };
        net_pins.entry(net.clone()).or_default().push(Pin { pin_id: pid, pos: Point::new(x, y) });
    }

    let stack = LayerStack {
        layers: (1..=n_signal_layers)
            .map(|i| LayerDef {
                index: i,
                name: format!("L{i}"),
                kind: "signal".to_string(),
                preferred_dir: "any".to_string(),
            })
            .collect(),
        via_kind: "through".to_string(),
    };

    let mut nets: Vec<Net> = Vec::new();
    let raw_count = net_pins.len();
    let mut net_keys: Vec<String> = net_pins.keys().cloned().collect();
    net_keys.sort();
    for net in net_keys {
        let pins = net_pins.remove(&net).unwrap();
        let Some(nc) = classify_net(&net) else {
            continue; // NC 直接删
        };
        if let Some(w) = &whitelist {
            if !w.contains(&net) {
                continue; // 白名单外全部不要
            }
        }
        if pins.len() < 2 {
            continue; // 单 pin 无法成飞线
        }
        nets.push(Net {
            net_id: net.clone(),
            net_class: nc,
            signal_group_id: None,
            net_group_id: None,
            pins,
            width,
            clearance,
        });
    }
    if whitelist.is_some() {
        warnings.push(format!(
            "白名单筛选：保留 {} 个 net（原始 {} 个）",
            nets.len(),
            raw_count
        ));
    }

    let sig_nets: Vec<Net> = nets.iter().filter(|n| n.net_class == NetClass::Signal).cloned().collect();
    let groups = vec![SignalGroup {
        group_id: "default".to_string(),
        allowed_layers: stack.signal_layers(),
        net_ids: sig_nets.iter().map(|n| n.net_id.clone()).collect(),
    }];
    let wires = generate_wires(&nets, &mut warnings);
    Ok(LoadedData {
        stack: Some(stack),
        signal_groups: groups,
        net_groups: Vec::new(),
        nets,
        keepouts: Vec::new(),
        wires,
        units: Units::Mm,
        warnings,
    })
}

fn _cell_f64_str(s: &str) -> Option<f64> {
    s.parse::<f64>().ok()
}
