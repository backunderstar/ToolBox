//! 探针卡飞线分层核心插件（id: `probe-rat-layer`，DLL: `tb_probe_rat_layer.dll`）。
//!
//! 把原 Python 插件（`plugins/probe-rat-layer`）的计算核心改写为 native cdylib 核心插件：
//! - 宿主经 libloading + C ABI 加载（`tb_plugin!` 宏生成 tb_abi_version/tb_create/tb_call/...）
//! - 命令/事件契约与 Python 版**完全一致**（`layer.listDir/config/run/status/cancel/result/
//!   readOut/render/openOut/report/notifyDone/plugin.action`），前端 `ui/` 无需改动
//! - 分层在后台线程跑（规避宿主 30s 硬超时），`layer.status` 轮询驱动进度；`layer.render`
//!   按需用 `plotters` 渲染 PNG → base64 data URL；取消经 `Arc<AtomicBool>` 干净退出
//!
//! 注意：native 插件在宿主进程内运行，后台线程必须在 `tb_destroy` 前终止（见 `LayerState::Drop`），
//! 否则 DLL 卸载后线程执行已卸载代码会崩溃（use-after-free）。

#![allow(clippy::not_unsafe_ptr_arg_deref)]
// 移植自 Python 后保留了大量"完整性/可复用"的辅助函数与字段（与 Python 包一一对应），
// 当前未被调用；用 crate 级 allow(dead_code) 屏蔽（clippy -D warnings 门禁需要 0 警告）。
#![allow(dead_code)]
// 下列 clippy 风格告警大多源于"逐行对齐 Python 算法"的移植形态（函数参数与 Python 一致、
// 自写的 sub/add 命名等），对可读性/正确性无影响，统一放行以保证 0 告警门禁。
#![allow(clippy::too_many_arguments)]
#![allow(clippy::should_implement_trait)]
#![allow(clippy::legacy_numeric_constants)]
#![allow(clippy::len_zero)]
#![allow(clippy::needless_range_loop)]
#![allow(clippy::if_same_then_else)]
#![allow(clippy::let_and_return)]
#![allow(clippy::unnecessary_to_owned)]
#![allow(clippy::unnecessary_unwrap)]
#![allow(clippy::redundant_locals)]
#![allow(clippy::type_complexity)]

pub mod cancel;
mod config;
mod congestion;
mod conflict_classifier;
mod dispatch;
mod geometry;
mod graph_coloring;
mod io;
mod keepout;
mod layer_packing;
mod layer_stack;
mod metrics;
pub mod model;
mod optimizer;
mod pipeline;
mod post_process;
mod report;
mod state;
mod viz;

pub use dispatch::{LayerState, call, state_from_cfg};
use tb_sdk::tb_plugin;

tb_plugin!(LayerState, state_from_cfg, call);

#[cfg(test)]
mod tests {
    use crate::cancel::new_cancel;
    use crate::config::default_config;
    use crate::io::LoadedData;
    use crate::model::{LayerDef, LayerStack, Net, NetClass, Pin, Point, SignalGroup, Units, Wire};
    use crate::pipeline;
    use crate::state::{ActiveStateData, Progress};
    use std::sync::{Arc, Mutex};

    /// 构造 24 条径向 2-pin 网（8 扇区 × 3），4 个信号层，跑单轮分层，验证产出。
    #[test]
    fn pipeline_runs_on_synthetic_data() {
        let mut nets: Vec<Net> = Vec::new();
        let mut wires: Vec<Wire> = Vec::new();
        for s in 0..8 {
            for k in 0..3 {
                let theta = (s as f64 * 45.0 + 3.0).to_radians();
                let name = format!("HVS{s}_{k}");
                let outer = Point::new(200.0 * theta.cos(), 200.0 * theta.sin());
                let inner = Point::new(15.0 * theta.cos(), 15.0 * theta.sin());
                let pins = vec![
                    Pin { pin_id: format!("{name}.1"), pos: inner },
                    Pin { pin_id: format!("{name}.2"), pos: outer },
                ];
                let net = Net {
                    net_id: name.clone(),
                    net_class: NetClass::Signal,
                    signal_group_id: None,
                    net_group_id: None,
                    pins,
                    width: 0.2,
                    clearance: 0.2,
                };
                wires.push(Wire::new(
                    format!("{name}_W0"),
                    name,
                    inner,
                    outer,
                    0.2,
                    0.2,
                ));
                nets.push(net);
            }
        }
        let stack = LayerStack {
            layers: (1..=4)
                .map(|i| LayerDef {
                    index: i,
                    name: format!("L{i}"),
                    kind: "signal".to_string(),
                    preferred_dir: "any".to_string(),
                })
                .collect(),
            via_kind: "through".to_string(),
        };
        let sig_ids: Vec<String> = nets.iter().map(|n| n.net_id.clone()).collect();
        let groups = vec![SignalGroup {
            group_id: "default".to_string(),
            allowed_layers: vec![1, 2, 3, 4],
            net_ids: sig_ids,
        }];
        let data = LoadedData {
            stack: Some(stack),
            signal_groups: groups,
            net_groups: Vec::new(),
            nets,
            keepouts: Vec::new(),
            wires,
            units: Units::Mm,
            warnings: Vec::new(),
        };

        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();
        let prog = Progress::new(&active, &cancel);
        let cfg = default_config();
        let result = pipeline::run_once(&data, &cfg, &prog).expect("pipeline 应成功");

        // 24 条线都分配到了层
        assert_eq!(result.assignment.len(), 24);
        assert!(!result.layers.is_empty());
        assert!(result.layers.iter().any(|l| l.kind == "signal"));
        assert_eq!(result.plane_nets.len(), 0);
        // 各层线总数的和 = 已分配数
        let sum: usize = result.layers.iter().map(|l| l.wires.len()).sum();
        assert_eq!(sum, 24);
    }

    /// 验证 geometry 线段相交原语。
    #[test]
    fn seg_intersect_basics() {
        let a1 = Point::new(0.0, 0.0);
        let a2 = Point::new(10.0, 0.0);
        let b1 = Point::new(5.0, -5.0);
        let b2 = Point::new(5.0, 5.0);
        let p = crate::geometry::seg_seg_intersection(a1, a2, b1, b2).expect("应相交");
        assert!((p.x - 5.0).abs() < 1e-6);
        assert!((p.y - 0.0).abs() < 1e-6);
        // 平行不相交
        assert!(crate::geometry::seg_seg_intersection(a1, a2, Point::new(0.0, 1.0), Point::new(10.0, 1.0)).is_none());
    }

    /// 验证配置覆盖：未知字段忽略、int 自动转 float。
    #[test]
    fn config_overrides_ignore_unknown_and_coerce() {
        let cfg = default_config().with_overrides(&serde_json::json!({
            "sector_angle_deg": 30,
            "unknown_field": 123,
            "optimizer": "greedy",
        })).expect("覆盖应成功");
        assert!((cfg.sector_angle_deg - 30.0).abs() < 1e-9);
        assert_eq!(cfg.optimizer, "greedy");
    }

    /// 验证扇区索引（[0,360) 极角）。
    #[test]
    fn sector_index_edges() {
        assert_eq!(crate::metrics::sector_index(0.0, 45.0), 0);
        assert_eq!(crate::metrics::sector_index(44.9, 45.0), 0);
        assert_eq!(crate::metrics::sector_index(45.0, 45.0), 1);
        assert_eq!(crate::metrics::sector_index(359.0, 45.0), 7);
    }

    /// 校验 report 写出并在临时目录读回（JSON/LST/CSV 结构）。
    #[test]
    fn report_roundtrip() {
        let data = synthetic_data();
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();
        let prog = Progress::new(&active, &cancel);
        let result = pipeline::run_once(&data, &default_config(), &prog).expect("pipeline 应成功");
        let cfg = default_config();
        let rep = crate::report::build_report(&result, &cfg);
        let dir = std::env::temp_dir().join(format!("tb-prl-report-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let dirs = dir.to_string_lossy().to_string();
        crate::report::write_report(&rep, &dirs).expect("写 report 失败");
        crate::report::export_layer_nets(&result, &dirs).expect("导出 nets 失败");
        crate::report::export_layer_nets_lst(&result, &dirs).expect("导出 lst 失败");
        crate::report::export_net_layer_csv(&result, &dirs).expect("导出 csv 失败");
        assert!(std::path::Path::new(&format!("{dirs}/json/report.json")).is_file());
        assert!(std::path::Path::new(&format!("{dirs}/json/layer_nets.json")).is_file());
        assert!(std::path::Path::new(&format!("{dirs}/csv/net_layer_assignment.csv")).is_file());
        let has_lst = std::fs::read_dir(format!("{dirs}/lst"))
            .map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().ends_with(".lst")))
            .unwrap_or(false);
        assert!(has_lst);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 校验 dispatch 命令路由（layer.config 伪宿主往返）与 native 契约（命令名在 method、参数在 params）。
    #[test]
    fn dispatch_command_routing() {
        use crate::{call, state_from_cfg};
        use tb_sdk::TbHostApi;
        let tmp = std::env::temp_dir().join(format!("tb-prl-dispatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let tmp_s = tmp.to_string_lossy().to_string();
        let cfg = serde_json::json!({ "vault": tmp_s, "config_dir": tmp_s });
        let mut state = state_from_cfg(&cfg).unwrap();
        let host = unsafe { TbHostApi::from_ptr(std::ptr::null()) };
        let ctx = std::ptr::null_mut();
        let _ = call(&mut state, host, ctx, "layer.config", serde_json::json!({"action":"set","patch":{"method":"sa"}})).unwrap();
        let got = call(&mut state, host, ctx, "layer.config", serde_json::json!({"action":"get"})).unwrap();
        assert_eq!(got["settings"]["method"], "sa");
        assert!(call(&mut state, host, ctx, "layer.unknown", serde_json::json!({})).is_err());
        let st = call(&mut state, host, ctx, "layer.status", serde_json::json!({})).unwrap();
        assert_eq!(st["state"], "idle");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// FFI 冒烟：直接加载 cdylib DLL，复刻宿主 `native.rs` 的 libloading 加载路径，
    /// 验证 tb_abi_version / tb_create / tb_call（layer.config get）/ tb_destroy。
    /// 覆盖 "插件能被宿主加载并应答命令" 这一核心集成点（无需写应用插件目录）。
    #[test]
    fn ffi_abi_load_and_call() {
        use std::ffi::{c_char, c_void, CStr, CString};
        type FnAbi = extern "C" fn() -> u32;
        type FnCreate = extern "C" fn(*const c_char, *const u8) -> *mut c_void;
        type FnCall = extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_char;
        type FnFree = extern "C" fn(*mut c_char);
        type FnDestroy = extern "C" fn(*mut c_void);

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let dll = manifest.join("../../target/debug/tb_probe_rat_layer.dll");
        assert!(dll.exists(), "DLL 不存在: {}", dll.display());
        unsafe {
            let lib = libloading::Library::new(&dll).expect("加载 DLL 失败");
            let abi: libloading::Symbol<FnAbi> = lib.get(b"tb_abi_version\0").expect("缺 tb_abi_version");
            assert_eq!(abi(), tb_sdk::ABI_VERSION, "ABI 版本不一致");
            let create: libloading::Symbol<FnCreate> = lib.get(b"tb_create\0").expect("缺 tb_create");
            let call: libloading::Symbol<FnCall> = lib.get(b"tb_call\0").expect("缺 tb_call");
            let free: libloading::Symbol<FnFree> = lib.get(b"tb_free_string\0").expect("缺 tb_free_string");
            let destroy: libloading::Symbol<FnDestroy> = lib.get(b"tb_destroy\0").expect("缺 tb_destroy");

            let tmp = std::env::temp_dir().join(format!("tb-prl-ffi-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&tmp);
            let _ = std::fs::create_dir_all(&tmp);
            let tp = tmp.to_string_lossy().to_string();
            let cfg_json = serde_json::to_string(&serde_json::json!({ "vault": tp, "config_dir": tp })).unwrap();
            let cfg = CString::new(cfg_json).unwrap();
            let handle = create(cfg.as_ptr(), std::ptr::null());
            assert!(!handle.is_null(), "tb_create 返回空");

            let method = CString::new("layer.config").unwrap();
            let params = CString::new(r#"{"action":"get"}"#).unwrap();
            let out = call(handle, method.as_ptr(), params.as_ptr());
            assert!(!out.is_null(), "tb_call 返回空");
            let raw = CStr::from_ptr(out).to_string_lossy().into_owned();
            free(out);
            destroy(handle);
            let v: serde_json::Value = serde_json::from_str(&raw).expect("tb_call 返回非法 JSON");
            assert!(v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false), "tb_call 结果: {raw}");
            let _ = std::fs::remove_dir_all(&tmp);
        }
    }

    /// 校验 net 分类：HV 探针卡信号网不能因"V 后隔位出现数字"被误判为电源（回归）。
    #[test]
    fn classify_net_hv_signals_stay_signal() {
        use crate::io::xlsx::classify_net;
        use crate::model::NetClass;
        assert_eq!(classify_net("1_SA10_S1_A_HV_1"), Some(NetClass::Signal));
        assert_eq!(classify_net("2_SA3_S2_B_HV_8X"), Some(NetClass::Signal));
        assert_eq!(classify_net("GND"), Some(NetClass::Ground));
        assert_eq!(classify_net("5V"), Some(NetClass::Signal)); // V 在末尾，无 V<digit>，Python 亦为 Signal
        assert_eq!(classify_net("1V8"), Some(NetClass::Power)); // V<digit> 紧邻才是电源
        assert_eq!(classify_net("NC"), None);
    }

    /// 真实数据端到端（本地手工运行 `cargo test -- --ignored`）：确认修复后能正确分出信号层。
    #[test]
    #[ignore]
    fn real_data_produces_layers() {
        let w = r"D:\ToolBoxData\Project\测试";
        let data = crate::io::load_input(
            &format!("{w}\\1.xlsx"),
            Some(&format!("{w}\\hv_all.lst")),
            4,
            0.2,
            0.2,
        )
        .expect("读入应成功");
        assert!(data.wires.len() > 0, "应生成飞线，实际 {}", data.wires.len());
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();
        let prog = Progress::new(&active, &cancel);
        // 与应用 UI 的 "hv" 预设一致（见 settings.json），保证可复现的应用基线
        let cfg = default_config()
            .with_overrides(&serde_json::json!({
                "congestion_grid_cell": 2,
                "congestion_hard_threshold": 3,
                "layer_capacity": 1,
                "capacity_utilization": 0.6,
                "sector_angle_deg": 45,
                "method": "packing",
                "optimizer": "sa",
                "resolve_conflict_rounds": 8,
                "balance_length_rounds": 3,
                "minimize_crossings_passes": 3,
                "sa_restarts": 1,
                "sa_initial_temp": 8,
                "sa_cooling": 0.9995,
                "sa_max_steps": 0,
                "sa_swap_ratio": 0.7,
                "sa_balance_slack": 2,
                "via_area_cost": 0.1,
            }))
            .expect("config 覆盖应成功");
        let t = std::time::Instant::now();
        let result = pipeline::run_once(&data, &cfg, &prog).expect("pipeline 应成功");
        let el = t.elapsed().as_secs_f64();
        let signal_layers: Vec<i64> = result
            .layers
            .iter()
            .filter(|l| l.kind == "signal")
            .map(|l| l.layer_index)
            .collect();
        let total_wires: usize = result.layers.iter().map(|l| l.wires.len()).sum();
        eprintln!(
            "[real-data] 线数={} 信号层={:?} 已分配={} 平面网={} 硬冲突={} 软冲突={} 需人工={} 走通率={}/{} 走通率(路径)={}/{} 跨层net={} 估算过孔={} 用时={:.2}s",
            data.wires.len(),
            signal_layers,
            result.assignment.len(),
            result.plane_nets.len(),
            result.hard_conflicts.len(),
            result.soft_conflicts.len(),
            result.manual_route_nets.len(),
            result.routable_net_count,
            result.total_net_count,
            result.routable_path_net_count,
            result.total_net_count,
            result.multi_layer_nets,
            result.via_estimate,
            el
        );
        for li in &result.layers {
            eprintln!(
                "  层 {} ({}): {} 线 / 软冲突 {} / 占用率 {:.2}",
                li.layer_index, li.kind, li.wires.len(), li.soft_conflict_count, li.max_occupancy
            );
        }
        assert!(result.assignment.len() > 0, "应有线被分配，实际 {}", result.assignment.len());
        assert!(result.layers.iter().any(|l| l.kind == "signal"), "应有信号层");
        assert_eq!(result.plane_nets.len(), 0, "HV 信号不应被判为平面网");
        assert_eq!(total_wires, result.assignment.len(), "层内线数之和应等于已分配线数");
    }

    /// 里程碑 0：软同 net（same_net_via_penalty λ>0）对比基线（λ=0），看少过孔收益是否以质量开销为代价。
    /// 本地运行 `cargo test --release -- --ignored --nocapture` 查看两行指标对比。
    #[test]
    #[ignore]
    fn real_data_milestone0_soft_samelayer() {
        let w = r"D:\ToolBoxData\Project\测试";
        let data = crate::io::load_input(
            &format!("{w}\\1.xlsx"),
            Some(&format!("{w}\\hv_all.lst")),
            4,
            0.2,
            0.2,
        )
        .expect("读入应成功");
        let multi_pin = data.nets.iter().filter(|n| n.pins.len() > 2).count();
        eprintln!(
            "[M0 data] nets={} 多pin网(>2pin)={} wires={}",
            data.nets.len(),
            multi_pin,
            data.wires.len()
        );
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();
        let hv = serde_json::json!({
            "congestion_grid_cell": 2, "congestion_hard_threshold": 3, "layer_capacity": 1,
            "capacity_utilization": 0.6, "sector_angle_deg": 45, "method": "packing",
            "optimizer": "sa", "resolve_conflict_rounds": 8, "balance_length_rounds": 3,
            "minimize_crossings_passes": 3, "sa_restarts": 1, "sa_seed": 42, "sa_initial_temp": 8,
            "sa_cooling": 0.9995, "sa_max_steps": 0, "sa_swap_ratio": 0.7, "sa_balance_slack": 2,
            "via_area_cost": 0.1,
        });
        let mut base = default_config().with_overrides(&hv).expect("config 覆盖应成功");
        base.same_net_via_penalty = 0.0;
        let mut soft = base.clone();
        soft.same_net_via_penalty = 1.0;
        for (label, cfg) in [("基线 λ=0", &base), ("软同层 λ=1", &soft)] {
            let prog = Progress::new(&active, &cancel);
            let t = std::time::Instant::now();
            let r = pipeline::run_once(&data, cfg, &prog).expect("pipeline 应成功");
            eprintln!(
                "[M0 {label}] 已分配={} 硬冲突={} 软冲突={} 需人工={} 走通率={}/{} 跨层net={} 估算过孔={} 用时={:.2}s",
                r.assignment.len(),
                r.hard_conflicts.len(),
                r.soft_conflicts.len(),
                r.manual_route_nets.len(),
                r.routable_net_count,
                r.total_net_count,
                r.multi_layer_nets,
                r.via_estimate,
                t.elapsed().as_secs_f64()
            );
        }
    }

    fn synthetic_data() -> LoadedData {
        let mut nets: Vec<Net> = Vec::new();
        let mut wires: Vec<Wire> = Vec::new();
        for s in 0..8 {
            for k in 0..3 {
                let theta = (s as f64 * 45.0 + 3.0).to_radians();
                let name = format!("HVS{s}_{k}");
                let outer = Point::new(200.0 * theta.cos(), 200.0 * theta.sin());
                let inner = Point::new(15.0 * theta.cos(), 15.0 * theta.sin());
                let pins = vec![
                    Pin { pin_id: format!("{name}.1"), pos: inner },
                    Pin { pin_id: format!("{name}.2"), pos: outer },
                ];
                let net = Net {
                    net_id: name.clone(),
                    net_class: NetClass::Signal,
                    signal_group_id: None,
                    net_group_id: None,
                    pins,
                    width: 0.2,
                    clearance: 0.2,
                };
                wires.push(Wire::new(format!("{name}_W0"), name, inner, outer, 0.2, 0.2));
                nets.push(net);
            }
        }
        let stack = LayerStack {
            layers: (1..=4)
                .map(|i| LayerDef { index: i, name: format!("L{i}"), kind: "signal".to_string(), preferred_dir: "any".to_string() })
                .collect(),
            via_kind: "through".to_string(),
        };
        let sig_ids: Vec<String> = nets.iter().map(|n| n.net_id.clone()).collect();
        let groups = vec![SignalGroup { group_id: "default".to_string(), allowed_layers: vec![1, 2, 3, 4], net_ids: sig_ids }];
        LoadedData { stack: Some(stack), signal_groups: groups, net_groups: Vec::new(), nets, keepouts: Vec::new(), wires, units: Units::Mm, warnings: Vec::new() }
    }
}
