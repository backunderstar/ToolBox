//! 按需渲染：用 `plotters` 把 layer/overview/rose/manual 渲染成 PNG → base64 data URL
//! （原 matplotlib 栈的轻量替代；前端 `<img src="data:...">` 直显，比 SVG DOM 光栅化快）。
//!
//! 协议与 Python 版一致：`layer.render` 成功返回 PNG data URL **字符串**；未命中（或渲染
//! 失败）抛错。native 插件在宿主进程内无 30s 硬超时，且调用被宿主串行化 → 同步渲染即可，
//! 前端拿到字符串后记缓存秒开（与 Python 的"文件缓存 + 轮询 pending"效果等价）。

use crate::config::{default_config, LayeringConfig};
use crate::model::{CircleZone, KeepoutZone, Point, RectZone, Wire};
use plotters::coord::cartesian::Cartesian2d;
use plotters::coord::types::RangedCoordf64;
use plotters::coord::Shift;
use plotters::prelude::*;
use serde_json::{json, Value};
use std::io::Cursor;

struct Geom {
    wires: Vec<Wire>,
    zones: Vec<KeepoutZone>,
    cfg: LayeringConfig,
}

struct Res {
    layers: Vec<LayerInfoLite>,
    manual_route_nets: Vec<String>,
}

struct LayerInfoLite {
    layer_index: i64,
    kind: String,
    wires: Vec<String>,
    nets: Vec<String>,
    soft_conflict_count: i64,
    max_occupancy: f64,
}

type Ctx<'r, 'b> = ChartContext<'r, BitMapBackend<'b>, Cartesian2d<RangedCoordf64, RangedCoordf64>>;

pub fn render(plugin_dir: &str, job_id: &str, kind: &str) -> Result<Value, String> {
    let jdir = format!("{plugin_dir}/jobs/{job_id}");
    let geo_content = std::fs::read_to_string(format!("{jdir}/geometry.json"))
        .map_err(|e| format!("读取几何数据失败: {e}"))?;
    let res_content = std::fs::read_to_string(format!("{jdir}/result.json"))
        .map_err(|e| format!("读取结果数据失败: {e}"))?;
    let geo_json: Value = serde_json::from_str(&geo_content).map_err(|e| e.to_string())?;
    let res_json: Value = serde_json::from_str(&res_content).map_err(|e| e.to_string())?;

    let geom = parse_geom(&geo_json)?;
    let res = parse_res(&res_json);
    let wire_by_id: crate::collections::HashMap<String, Wire> =
        geom.wires.iter().map(|w| (w.wire_id.clone(), w.clone())).collect();

    let (name, png) = match kind {
        "overview" => ("overview".to_string(), render_overview(&geom, &wire_by_id, &res)?),
        "rose" => ("rose".to_string(), render_rose(&geom, &wire_by_id, &res)?),
        "manual" => ("manual".to_string(), render_manual(&geom, &res)?),
        k if k.starts_with("layer_") => {
            let idx = k[6..].parse::<i64>().map_err(|_| format!("未知渲染类型: {kind}"))?;
            let li = res
                .layers
                .iter()
                .find(|l| l.layer_index == idx)
                .ok_or_else(|| format!("层不存在: {k}"))?;
            (format!("layer_{idx:02}"), render_layer(li, &wire_by_id, &geom)?)
        }
        _ => return Err(format!("未知渲染类型: {kind}")),
    };
    let img_dir = format!("{jdir}/img");
    let _ = std::fs::create_dir_all(&img_dir);
    let _ = std::fs::write(format!("{img_dir}/{name}.png"), &png);
    Ok(json!(png_data_url(&png)))
}

fn png_data_url(bytes: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:image/png;base64,{b64}")
}

fn parse_geom(v: &Value) -> Result<Geom, String> {
    let mut wires = Vec::new();
    if let Some(arr) = v.get("wires").and_then(|x| x.as_array()) {
        for w in arr {
            let start = w.get("start").and_then(|s| s.as_array()).cloned().unwrap_or_default();
            let end = w.get("end").and_then(|s| s.as_array()).cloned().unwrap_or_default();
            if start.len() < 2 || end.len() < 2 {
                continue;
            }
            wires.push(Wire::new(
                w.get("wire_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                w.get("net_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                Point::new(start[0].as_f64().unwrap_or(0.0), start[1].as_f64().unwrap_or(0.0)),
                Point::new(end[0].as_f64().unwrap_or(0.0), end[1].as_f64().unwrap_or(0.0)),
                w.get("width").and_then(|x| x.as_f64()).unwrap_or(0.2),
                w.get("clearance").and_then(|x| x.as_f64()).unwrap_or(0.2),
            ));
        }
    }
    let mut zones = Vec::new();
    if let Some(arr) = v.get("keepouts").and_then(|x| x.as_array()) {
        for z in arr {
            match z.get("type").and_then(|x| x.as_str()).unwrap_or("") {
                "rect" => zones.push(KeepoutZone::Rect(RectZone {
                    zone_id: z.get("zone_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    xmin: z.get("xmin").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    ymin: z.get("ymin").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    xmax: z.get("xmax").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    ymax: z.get("ymax").and_then(|x| x.as_f64()).unwrap_or(0.0),
                })),
                "circle" => zones.push(KeepoutZone::Circle(CircleZone {
                    zone_id: z.get("zone_id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    center: Point::new(
                        z.get("center").and_then(|c| c.get(0)).and_then(|x| x.as_f64()).unwrap_or(0.0),
                        z.get("center").and_then(|c| c.get(1)).and_then(|x| x.as_f64()).unwrap_or(0.0),
                    ),
                    radius: z.get("radius").and_then(|x| x.as_f64()).unwrap_or(0.0),
                })),
                _ => {}
            }
        }
    }
    let mut cfg = default_config();
    if let Some(c) = v.get("cfg") {
        let merged = cfg.clone().with_overrides(c);
        if let Ok(m) = merged {
            cfg = m;
        }
    }
    Ok(Geom { wires, zones, cfg })
}

fn parse_res(v: &Value) -> Res {
    let mut layers = Vec::new();
    if let Some(arr) = v.get("layers").and_then(|x| x.as_array()) {
        for li in arr {
            layers.push(LayerInfoLite {
                layer_index: li.get("layer").and_then(|x| x.as_i64()).unwrap_or(0),
                kind: li.get("kind").and_then(|x| x.as_str()).unwrap_or("signal").to_string(),
                wires: arr_strs(li, "wires"),
                nets: arr_strs(li, "nets"),
                soft_conflict_count: li.get("soft_conflict_count").and_then(|x| x.as_i64()).unwrap_or(0),
                max_occupancy: li.get("max_occupancy").and_then(|x| x.as_f64()).unwrap_or(0.0),
            });
        }
    }
    Res { layers, manual_route_nets: arr_strs(v, "manual_route_nets") }
}

fn arr_strs(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

// ---------- plotters 帮助 ----------

fn color_from_str(s: &str) -> RGBColor {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    RGBColor(((h >> 16) & 0xFF) as u8, ((h >> 8) & 0xFF) as u8, (h & 0xFF) as u8)
}

const TAB10: [RGBColor; 10] = [
    RGBColor(31, 119, 180), RGBColor(255, 127, 14), RGBColor(44, 160, 44),
    RGBColor(214, 39, 40), RGBColor(148, 103, 189), RGBColor(140, 86, 75),
    RGBColor(227, 119, 194), RGBColor(127, 127, 127), RGBColor(188, 189, 34),
    RGBColor(23, 190, 207),
];

/// 在 (w,h) 位图上执行 draw，返回 PNG 字节。
fn with_root<F>(w: u32, h: u32, draw: F) -> Result<Vec<u8>, String>
where
    F: FnOnce(&mut DrawingArea<BitMapBackend<'_>, Shift>) -> Result<(), String>,
{
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 3];
    {
        let backend = BitMapBackend::with_buffer(&mut buf, (w, h));
        let mut root = backend.into_drawing_area();
        root.fill(&WHITE).map_err(|e| format!("绘图失败: {e}"))?;
        draw(&mut root)?;
        root.present().map_err(|e| format!("绘图失败: {e}"))?;
    }
    let img = image::RgbImage::from_raw(w, h, buf).ok_or_else(|| "创建图像失败".to_string())?;
    let mut bytes = Vec::new();
    img.write_to(&mut Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| format!("PNG 编码失败: {e}"))?;
    Ok(bytes)
}

fn build_chart<'r, 'b>(
    root: &'r DrawingArea<BitMapBackend<'b>, Shift>,
    br: (f64, f64, f64, f64),
) -> Result<Ctx<'r, 'b>, String> {
    let (xmin, xmax, ymin, ymax) = br;
    let mut chart = ChartBuilder::on(root)
        .margin(10)
        .x_label_area_size(0)
        .y_label_area_size(0)
        .build_cartesian_2d(xmin..xmax, ymin..ymax)
        .map_err(|e| format!("构建图表失败: {e}"))?;
    chart.configure_mesh().light_line_style(WHITE).draw().map_err(|e| e.to_string())?;
    Ok(chart)
}

fn bbox(geom: &Geom) -> (f64, f64, f64, f64) {
    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    for w in &geom.wires {
        xs.push(w.start.x);
        xs.push(w.end.x);
        ys.push(w.start.y);
        ys.push(w.end.y);
    }
    for z in &geom.zones {
        match z {
            KeepoutZone::Rect(r) => {
                xs.push(r.xmin);
                xs.push(r.xmax);
                ys.push(r.ymin);
                ys.push(r.ymax);
            }
            KeepoutZone::Circle(c) => {
                xs.push(c.center.x - c.radius);
                xs.push(c.center.x + c.radius);
                ys.push(c.center.y - c.radius);
                ys.push(c.center.y + c.radius);
            }
        }
    }
    if xs.is_empty() {
        return (0.0, 1.0, 0.0, 1.0);
    }
    let xmin = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let xmax = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let ymin = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let ymax = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let span = (xmax - xmin).max(ymax - ymin).max(1.0);
    let pad = span * 0.05;
    let cx = (xmin + xmax) / 2.0;
    let cy = (ymin + ymax) / 2.0;
    (cx - span / 2.0 - pad, cx + span / 2.0 + pad, cy - span / 2.0 - pad, cy + span / 2.0 + pad)
}

fn draw_keepout(chart: &mut Ctx<'_, '_>, zone: &KeepoutZone) -> Result<(), String> {
    let fill = RGBColor(217, 217, 217);
    let edge = RGBColor(214, 39, 40);
    match zone {
        KeepoutZone::Rect(r) => {
            let pts = vec![
                (r.xmin, r.ymin), (r.xmax, r.ymin), (r.xmax, r.ymax), (r.xmin, r.ymax), (r.xmin, r.ymin),
            ];
            chart.draw_series(std::iter::once(Polygon::new(pts.clone(), fill))).map_err(|e| e.to_string())?;
            chart.draw_series(std::iter::once(PathElement::new(pts, edge))).map_err(|e| e.to_string())?;
        }
        KeepoutZone::Circle(c) => {
            let n = 32;
            let mut pts = Vec::new();
            for i in 0..=n {
                let t = i as f64 / n as f64 * std::f64::consts::TAU;
                pts.push((c.center.x + c.radius * t.cos(), c.center.y + c.radius * t.sin()));
            }
            chart.draw_series(std::iter::once(Polygon::new(pts.clone(), fill))).map_err(|e| e.to_string())?;
            chart.draw_series(std::iter::once(PathElement::new(pts, edge))).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn draw_keepouts(chart: &mut Ctx<'_, '_>, geom: &Geom) -> Result<(), String> {
    for z in &geom.zones {
        draw_keepout(chart, z)?;
    }
    Ok(())
}

// ---------- 各图 ----------

fn render_layer(li: &LayerInfoLite, wire_by_id: &crate::collections::HashMap<String, Wire>, geom: &Geom) -> Result<Vec<u8>, String> {
    let br = bbox(geom);
    with_root(1200, 960, |root| {
        let mut chart = build_chart(root, br)?;
        draw_keepouts(&mut chart, geom)?;
        for wid in &li.wires {
            if let Some(w) = wire_by_id.get(wid) {
                chart
                    .draw_series(LineSeries::new(vec![(w.start.x, w.start.y), (w.end.x, w.end.y)], color_from_str(&w.net_id).stroke_width(2)))
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
}

fn render_overview(geom: &Geom, wire_by_id: &crate::collections::HashMap<String, Wire>, res: &Res) -> Result<Vec<u8>, String> {
    let br = bbox(geom);
    with_root(1200, 960, |root| {
        let mut chart = build_chart(root, br)?;
        draw_keepouts(&mut chart, geom)?;
        for li in &res.layers {
            if li.kind == "plane" {
                continue;
            }
            let color = TAB10[((li.layer_index - 1).rem_euclid(10)) as usize];
            for wid in &li.wires {
                if let Some(w) = wire_by_id.get(wid) {
                    chart
                        .draw_series(LineSeries::new(vec![(w.start.x, w.start.y), (w.end.x, w.end.y)], color.stroke_width(2)))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    })
}

fn render_rose(geom: &Geom, wire_by_id: &crate::collections::HashMap<String, Wire>, res: &Res) -> Result<Vec<u8>, String> {
    let layers: Vec<&LayerInfoLite> = res.layers.iter().filter(|l| l.kind != "plane").collect();
    let n = layers.len().max(1);
    let cell_w = 360.0;
    let cell_h = 260.0;
    let (w, h) = ((cell_w * n as f64) as u32 + 60, (cell_h + 80.0) as u32);
    let nsect = (360.0 / geom.cfg.sector_angle_deg).round().max(1.0) as i64;
    with_root(w, h, |root| {
        for (k, li) in layers.iter().enumerate() {
            let ox = 30.0 + cell_w * k as f64 + cell_w / 2.0;
            let oy = cell_h / 2.0 + 40.0;
            let max_r = cell_h / 2.0 - 20.0;
            let mut counts = vec![0i64; nsect as usize];
            for wid in &li.wires {
                if let Some(ww) = wire_by_id.get(wid) {
                    let ang = crate::layer_packing::wire_dir_angle(ww);
                    let si = crate::metrics::sector_index(ang, geom.cfg.sector_angle_deg) as usize;
                    if si < counts.len() {
                        counts[si] += 1;
                    }
                }
            }
            let cmax = counts.iter().cloned().max().unwrap_or(0).max(1) as f64;
            let mut chart = build_chart(root, (ox - cell_w / 2.0, ox + cell_w / 2.0, oy - cell_h / 2.0, oy + cell_h / 2.0))?;
            let col = TAB10[((li.layer_index - 1).rem_euclid(10)) as usize];
            for (si, cnt) in counts.iter().enumerate() {
                if *cnt == 0 {
                    continue;
                }
                let r = *cnt as f64 / cmax * max_r;
                let a0 = (si as f64) * geom.cfg.sector_angle_deg.to_radians();
                let a1 = ((si as f64 + 1.0) * geom.cfg.sector_angle_deg).to_radians();
                let npts = 24;
                let mut pts = Vec::with_capacity(npts + 2);
                pts.push((ox, oy));
                for i in 0..=npts {
                    let a = a0 + (a1 - a0) * i as f64 / npts as f64;
                    pts.push((ox + r * a.cos(), oy + r * a.sin()));
                }
                pts.push((ox, oy));
                chart.draw_series(std::iter::once(Polygon::new(pts, RGBAColor(col.0, col.1, col.2, 0.7)))).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
}

fn render_manual(geom: &Geom, res: &Res) -> Result<Vec<u8>, String> {
    let manual: crate::collections::HashSet<String> = res.manual_route_nets.iter().cloned().collect();
    let wires: Vec<&Wire> = geom
        .wires
        .iter()
        .filter(|w| manual.contains(&w.net_id))
        .collect();
    if wires.is_empty() {
        return Err("无人工 route 线（本结果全部自动分层）".to_string());
    }
    let br = bbox(geom);
    with_root(1200, 960, |root| {
        let mut chart = build_chart(root, br)?;
        draw_keepouts(&mut chart, geom)?;
        for w in &wires {
            chart
                .draw_series(LineSeries::new(vec![(w.start.x, w.start.y), (w.end.x, w.end.y)], RGBColor(214, 39, 40).stroke_width(2)))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
}
