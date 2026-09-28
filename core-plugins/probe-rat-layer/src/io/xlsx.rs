//! Allegro pin 表 loader（xls/xlsx，calamine 替代 openpyxl+xlrd）+ 筛选文件。
//! 移植自 Python `probe_layer/io/xlsx_loader.py`。

use crate::io::LoadedData;
use crate::io::wire_gen::generate_wires;
use crate::model::{LayerDef, LayerStack, Net, NetClass, Pin, Point, SignalGroup, Units};
use calamine::{Data, Reader};
use crate::collections::HashMap;

// 列名别名：表头（小写）→ 规范列名
fn _col_aliases() -> HashMap<&'static str, &'static str> {
    let mut m = HashMap::default();
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

/// 是否应丢弃的网名：空 / NC（无连接）/ GND（地）。
/// 匹配大小写不敏感，且允许零个或多个 `=` 前缀（如 `===NC`、`===Gnd`，或裸 `NC`/`GND`）。
/// 探针卡数据中这些是特殊网，直接丢掉；**其余全部保留、不做 Signal/Power/Ground 分类，
/// 统一按信号网处理**（后续仅交给筛选文件 .lst 决定是否参与）。
pub fn should_drop_net(name: &str) -> bool {
    let norm = name.trim().trim_start_matches('=').trim().to_uppercase();
    if norm.is_empty() {
        return true;
    }
    norm == "NC" || norm == "GND"
}

fn _read_text_net_list(path: &str) -> Result<crate::collections::HashSet<String>, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("读取筛选文件失败: {e}"))?;
    let mut names = crate::collections::HashSet::default();
    for line in content.lines() {
        let v = line.trim();
        if v.is_empty() || v.starts_with('#') {
            continue;
        }
        // 归一化为大写，与 pin 表 NET_NAME（大写）做大小写不敏感匹配
        names.insert(v.to_uppercase());
    }
    Ok(names)
}

fn _read_net_whitelist_table(path: &str) -> Result<crate::collections::HashSet<String>, String> {
    let rows = _read_rows(path)?;
    let mut names = crate::collections::HashSet::default();
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
        // 归一化为大写，做大小写不敏感匹配（见表单路径说明）
        names.insert(v.to_uppercase());
    }
    Ok(names)
}

/// 读筛选文件：.lst/.txt 按文本（一行一个 net）；.xls/.xlsx 按表格第一列。
pub fn read_net_filter(path: &str) -> Result<crate::collections::HashSet<String>, String> {
    let lower = path.to_lowercase();
    if lower.ends_with(".lst") || lower.ends_with(".txt") {
        _read_text_net_list(path)
    } else {
        _read_net_whitelist_table(path)
    }
}

/// 读**多个**筛选文件，取**并集**作为白名单（大小写不敏感，见 `read_net_filter` 归一化为大写）。
pub fn read_net_filters(paths: &[String]) -> Result<crate::collections::HashSet<String>, String> {
    let mut w = crate::collections::HashSet::default();
    for p in paths {
        for name in read_net_filter(p)? {
            w.insert(name);
        }
    }
    Ok(w)
}

fn _columns(header_row: &[String]) -> (usize, usize, usize, Option<usize>, Option<usize>) {
    let aliases = _col_aliases();
    let mut col: HashMap<String, usize> = HashMap::default();
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
    filter_paths: &[String],
    n_signal_layers: i64,
    width: f64,
    clearance: f64,
) -> Result<LoadedData, String> {
    let mut warnings: Vec<String> = Vec::new();
    // 支持**多个筛选文件**：并集作为白名单（大小写不敏感，见 `read_net_filter` 归一化为大写）。
    let whitelist: Option<crate::collections::HashSet<String>> = if filter_paths.is_empty() {
        None
    } else {
        Some(read_net_filters(filter_paths)?)
    };
    let rows = _read_rows(path)?;
    if rows.is_empty() {
        return Err("表格为空: {path}".to_string());
    }
    let (net_i, x_i, y_i, ref_i, pin_i) = _columns(&rows[0]);

    let mut net_pins: HashMap<String, Vec<Pin>> = HashMap::default();
    let mut counter: HashMap<String, i64> = HashMap::default();
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
    // 先只剔特殊网（空 / NC / GND）与单 pin，其余全部当信号网保留（不分类）。
    for net in net_keys {
        let pins = net_pins.remove(&net).unwrap();
        if should_drop_net(&net) {
            continue; // 空 / NC / GND（含 === 前缀）丢弃
        }
        if pins.len() < 2 {
            continue; // 单 pin 无法成飞线
        }
        nets.push(Net {
            net_id: net.clone(),
            net_class: NetClass::Signal, // 不分类：其余全部当信号网
            signal_group_id: None,
            net_group_id: None,
            pins,
            width,
            clearance,
        });
    }
    // 筛选文件（.lst/.txt）放**最后一步**：分层前剔除不在并集白名单内的 net（**大小写不敏感**）。
    if let Some(w) = &whitelist {
        let before = nets.len();
        // 名单里查无此网的真实原因要能看见：此时 nets 已剔过特殊网/单 pin，
        // 所以"名单命中 0"可能是 ① 名字对不上（表里没这个 net）② 表里有但只有 1 个 pin（无法成飞线）。
        let table_names: crate::collections::HashSet<String> =
            nets.iter().map(|n| n.net_id.to_uppercase()).collect();
        let unmatched_list_names = w.iter().filter(|k| !table_names.contains(*k)).count();
        nets.retain(|n| w.contains(&n.net_id.to_uppercase()));
        if nets.is_empty() && before > 0 {
            warnings.push(format!(
                "⚠ 筛选文件与 pin 表无交集：名单 {} 条中 {} 条在 pin 表（剔特殊网/单 pin 后）里找不到同名 net。\
请检查筛选文件的 net 名是否来自同一份 pin 表（常见差异：尾缀 X/大小写以外的后缀、不同版本导出、Sense/Force 名单混用）",
                w.len(),
                unmatched_list_names
            ));
        }
        warnings.push(format!(
            "白名单筛选（{} 个筛选文件，大小写不敏感）：保留 {} 个 net（原始 {raw_count} 个，剔特殊网/单 pin 后 {before} 个）；\
名单 {} 条中 {} 条未匹配到表内 net",
            filter_paths.len(),
            nets.len(),
            w.len(),
            unmatched_list_names
        ));
    }

    let sig_nets: Vec<Net> = nets
        .iter()
        .filter(|n| n.net_class == NetClass::Signal)
        .cloned()
        .collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 筛选文件匹配应大小写不敏感：读入后归一化为大写（与 pin 表 NET_NAME 大写对齐）。
    #[test]
    fn filter_names_normalized_uppercase() {
        let dir = std::env::temp_dir().join(format!("tb-prl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.lst");
        std::fs::write(&p, "net_a\n.NET_B\n# comment\n\n").unwrap();
        let s = read_net_filter(p.to_str().unwrap()).unwrap();
        assert!(s.contains("NET_A"), "小写应归一化为大写");
        assert!(s.contains(".NET_B"));
        assert_eq!(s.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 多个筛选文件取**并集**，且大小写不敏感（归一化为大写）。
    #[test]
    fn filters_union_case_insensitive() {
        let dir = std::env::temp_dir().join(format!("tb-prl2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f1 = dir.join("a.lst");
        let f2 = dir.join("b.lst");
        std::fs::write(&f1, "NET_A\nNET_B").unwrap();
        std::fs::write(&f2, "net_b\nNET_C\n# comment\n").unwrap();
        let u = read_net_filters(&[f1.to_string_lossy().into(), f2.to_string_lossy().into()]).unwrap();
        assert!(u.contains("NET_A"));
        assert!(u.contains("NET_B")); // 两文件共有（小写归一化后合并）
        assert!(u.contains("NET_C"));
        assert_eq!(u.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 名单来自"另一份 pin 表"的场景：名字尾缀不同（如 X 变体）时交集为空，
    /// 这正是"筛选文件里的 net 没被分层（命中 0）"的形态。
    #[test]
    fn filter_names_from_other_table_do_not_match() {
        let dir = std::env::temp_dir().join(format!("tb-prl3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("other.lst");
        // 尾缀不同（X 变体）→ 与 pin 表名字不相等，白名单会整份落空
        std::fs::write(&f, "1_SA10_S1_A_DPS_S1A\n1_SA10_S1_A_DPS_S2A\n").unwrap();
        let wl = read_net_filter(f.to_str().unwrap()).unwrap();
        assert_eq!(wl.len(), 2);
        // 模拟 pin 表侧只有 X 变体：交集应为空（这正是"分层 0 个 net"的形态）
        let table: crate::collections::HashSet<String> =
            ["1_SA10_S1_A_DPS_S1AX", "1_SA10_S1_A_DPS_S2AX"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        assert_eq!(wl.iter().filter(|k| table.contains(*k)).count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
