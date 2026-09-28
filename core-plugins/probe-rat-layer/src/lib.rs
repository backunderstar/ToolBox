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
mod collections;
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

    /// 校验待丢弃网名：空 / NC / GND（大小写不敏感，`=` 前缀可有可无）；其余一律保留（不分类）。
    #[test]
    fn drop_net_special_names() {
        use crate::io::xlsx::should_drop_net;
        assert!(should_drop_net(""));
        assert!(should_drop_net("   "));
        assert!(should_drop_net("NC"));
        assert!(should_drop_net("nc"));
        assert!(should_drop_net("===NC"));
        assert!(should_drop_net("GND"));
        assert!(should_drop_net("Gnd"));
        assert!(should_drop_net("===Gnd"));
        assert!(!should_drop_net("1_SA10_S1_A_HV_1"));
        assert!(!should_drop_net("2_SA3_S2_B_HV_8X"));
        assert!(!should_drop_net("VDD"));
        assert!(!should_drop_net("VCC"));
        assert!(!should_drop_net("5V"));
        assert!(!should_drop_net("1V8"));
    }

    /// 真实数据端到端（本地手工运行 `cargo test -- --ignored`）：确认修复后能正确分出信号层。
    #[test]
    #[ignore]
    fn real_data_produces_layers() {
        let w = r"D:\ToolBoxData\Project\测试";
        let data = crate::io::load_input(
            &format!("{w}\\1.xlsx"),
            &[format!("{w}\\hv_all.lst")],
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
            "[real-data] 线数={} 信号层={:?} 已分配={} 平面网={} 硬冲突={} 软冲突={} 需人工={} 走通率={}/{} 走通率(路径)={}/{} 走通率(洪泛)={}/{} 跨层net={} 估算过孔={} 用时={:.2}s",
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
            result.routable_flood_net_count,
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
            &[format!("{w}\\hv_all.lst")],
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

    /// 里程碑 2：拥塞平滑代价 + 整网 reroute（ripup_rounds>0）对比基线，看最大层占用/走通率是否改善。
    #[test]
    #[ignore]
    fn real_data_milestone2_reroute() {
        let w = r"D:\ToolBoxData\Project\测试";
        let data = crate::io::load_input(
            &format!("{w}\\1.xlsx"),
            &[format!("{w}\\hv_all.lst")],
            4,
            0.2,
            0.2,
        )
        .expect("读入应成功");
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
        let base = default_config().with_overrides(&hv).expect("config 覆盖应成功");
        let mut reroute = base.clone();
        reroute.ripup_rounds = 8;
        reroute.congestion_k = 2.0;
        for (label, cfg) in [("基线 无reroute", &base), ("reroute 8轮", &reroute)] {
            let prog = Progress::new(&active, &cancel);
            let t = std::time::Instant::now();
            let r = pipeline::run_once(&data, cfg, &prog).expect("pipeline 应成功");
            let max_occ = r
                .layers
                .iter()
                .fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
            eprintln!(
                "[M2 {label}] 已分配={} 硬冲突={} 软冲突={} 需人工={} 走通率={}/{} 最大层占用={:.2} 用时={:.2}s",
                r.assignment.len(),
                r.hard_conflicts.len(),
                r.soft_conflicts.len(),
                r.manual_route_nets.len(),
                r.routable_net_count,
                r.total_net_count,
                max_occ,
                t.elapsed().as_secs_f64()
            );
        }
    }

    /// A/B：后处理拥塞均衡（congestion_balance）对 hv 1800 网的层占用峰值/走通率(洪泛)/需人工/硬冲突影响。
    #[test]
    #[ignore]
    fn real_data_congestion_balance_ab() {
        let w = r"D:\ToolBoxData\Project\测试";
        let data = crate::io::load_input(
            &format!("{w}\\1.xlsx"),
            &[format!("{w}\\hv_all.lst")],
            4,
            0.2,
            0.2,
        )
        .expect("读入应成功");
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
        let base = default_config().with_overrides(&hv).expect("config 覆盖应成功");
        let mut bal = base.clone();
        bal.congestion_balance = true;
        bal.congestion_balance_passes = 30;
        for (label, cfg) in [("基线 无均衡", &base), ("后处理均衡 on", &bal)] {
            let prog = Progress::new(&active, &cancel);
            let t = std::time::Instant::now();
            let r = pipeline::run_once(&data, cfg, &prog).expect("pipeline 应成功");
            let max_occ = r
                .layers
                .iter()
                .fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
            eprintln!(
                "[CB {label}] 已分配={} 硬冲突={} 软冲突={} 需人工={} 走通率(洪泛)={}/{} 最大层占用={:.2} 用时={:.2}s",
                r.assignment.len(),
                r.hard_conflicts.len(),
                r.soft_conflicts.len(),
                r.manual_route_nets.len(),
                r.routable_flood_net_count,
                r.total_net_count,
                max_occ,
                t.elapsed().as_secs_f64()
            );
        }
    }

    /// A/B：把"交叉最小化/SA 投入"默认值调高（minimize_crossings_passes / sa_restarts /
    /// resolve_conflict_rounds / balance_length_rounds / sa_max_steps），看软冲突(交叉)是否下降、代价多大。
    #[test]
    #[ignore]
    fn real_data_crossing_ab() {
        let w = r"D:\ToolBoxData\Project\测试";
        let data = crate::io::load_input(
            &format!("{w}\\1.xlsx"),
            &[format!("{w}\\hv_all.lst")],
            4,
            0.2,
            0.2,
        )
        .expect("读入应成功");
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
        let base = default_config().with_overrides(&hv).expect("config 覆盖应成功");
        let mut newd = base.clone();
        newd.resolve_conflict_rounds = 12;
        newd.balance_length_rounds = 6;
        newd.minimize_crossings_passes = 6;
        newd.sa_restarts = 2;
        let mut b_05 = newd.clone();
        b_05.congestion_balance = true;
        b_05.congestion_balance_cross_weight = 0.5;
        let mut b_20 = newd.clone();
        b_20.congestion_balance = true;
        b_20.congestion_balance_cross_weight = 2.0;
        for (label, cfg) in [
            ("新默认 无均衡 rounds12/bal6/pass6/restart2", &newd),
            ("新默认 + 拥塞均衡 cross=0.5", &b_05),
            ("新默认 + 拥塞均衡 cross=2.0", &b_20),
        ] {
            let prog = Progress::new(&active, &cancel);
            let t = std::time::Instant::now();
            let r = pipeline::run_once(&data, cfg, &prog).expect("pipeline 应成功");
            let max_occ = r
                .layers
                .iter()
                .fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
            let same_layer_cross: i64 = r.layers.iter().map(|l| l.soft_conflict_count).sum();
            eprintln!(
                "[XA {label}] 已分配={} 硬冲突={} 软冲突(几何)={} 同层交叉={} 需人工={} 走通率(洪泛)={}/{} 最大层占用={:.2} 用时={:.2}s",
                r.assignment.len(),
                r.hard_conflicts.len(),
                r.soft_conflicts.len(),
                same_layer_cross,
                r.manual_route_nets.len(),
                r.routable_flood_net_count,
                r.total_net_count,
                max_occ,
                t.elapsed().as_secs_f64()
            );
        }
    }

    /// 线宽=8（POWER，20 层）时验证 pin 邻近为**硬**约束：不同 net 任一端点(pin)对距离
    /// < 0.5×(线宽+间距) 的线对**不能放同一层**。应满足同层 pin 邻近违规数为 0。
    #[test]
    #[ignore]
    fn real_data_width8_pin_proximity() {
        let w = r"D:\ToolBoxData\Project\测试";
        let data = crate::io::load_input(
            &format!("{w}\\1.xlsx"),
            &[format!("{w}\\hv_all.lst")],
            20,
            8.0,
            0.2,
        )
        .expect("读入应成功");
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
        let cfg = default_config().with_overrides(&hv).expect("config 覆盖应成功");
        let prog = Progress::new(&active, &cancel);
        let r = pipeline::run_once(&data, &cfg, &prog).expect("pipeline 应成功");
        let mut violations = 0usize;
        let wires = &data.wires;
        for i in 0..wires.len() {
            for j in (i + 1)..wires.len() {
                let (a, b) = (&wires[i], &wires[j]);
                if a.net_id == b.net_id {
                    continue;
                }
                if let (Some(&la), Some(&lb)) = (r.assignment.get(&a.wire_id), r.assignment.get(&b.wire_id)) {
                    if la == lb {
                        // pin 间距放大到线径（线宽）
                        let req = a.width.max(b.width);
                        let mut ep = f64::INFINITY;
                        for p in [a.start, a.end] {
                            for q in [b.start, b.end] {
                                let d = p.dist(q);
                                if d < ep {
                                    ep = d;
                                }
                            }
                        }
                        if ep < req {
                            violations += 1;
                        }
                    }
                }
            }
        }
        eprintln!(
            "[width8/20层] 已分配={} 硬冲突={} 软冲突={} 需人工={} 走通率={}/{} 同层pin邻近违规={}",
            r.assignment.len(),
            r.hard_conflicts.len(),
            r.soft_conflicts.len(),
            r.manual_route_nets.len(),
            r.routable_net_count,
            r.total_net_count,
            violations
        );
        assert_eq!(violations, 0, "仍存在同层 pin 邻近违规: {violations}");
    }

    /// AC 预设标定扫描（本地手工运行）：用真实项目的 4 个 TDQ 筛选文件（1165P_3D，4660 网）
    /// 逐一评估候选参数组合，输出决定性指标：
    /// - **分层效果**：需人工 net 数、同层交叉（各层 soft_conflict_count 之和）、洪泛走通率、占用峰值；
    /// - **各层均匀**：层线数失衡 `(max-min)/mean`、层长失衡；
    /// - **各扇区均匀**：`metrics::sector_imbalance`（每扇区在各层间的 max-min 之和 / 总线数）、
    ///   以及扇区总线数的 min/max。
    ///
    /// 运行：`cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture real_data_ac_sweep`
    #[test]
    #[ignore]
    fn real_data_ac_sweep() {
        use crate::metrics;
        use std::collections::HashMap as StdHashMap;
        let dir = r"D:\ToolBoxData\Project\1165P_3D";
        let input = format!("{dir}\\1165P_3D_new.xlsx");
        let filters: Vec<String> = ["AC_TDQ0", "AC_TDQ1", "AC_TDQ8", "AC_TDQ9"]
            .iter()
            .map(|n| format!("{dir}\\LIST\\{n}.lst"))
            .collect();
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();

        // "质量优先"基线（与 DC 预设同款算法项）；各档只改需要比较的旋钮。
        let base = serde_json::json!({
            "congestion_grid_cell": 2, "congestion_hard_threshold": 3, "layer_capacity": 1,
            "capacity_utilization": 0.6, "sector_angle_deg": 45, "method": "packing",
            "optimizer": "sa", "resolve_conflict_rounds": 15, "balance_length_rounds": 6,
            "minimize_crossings_passes": 6, "sa_restarts": 3, "sa_seed": 42,
            "sa_initial_temp": 12, "sa_cooling": 0.9995, "sa_max_steps": 0,
            "sa_swap_ratio": 0.7, "sa_balance_slack": 2, "via_area_cost": 0.1,
            "congestion_balance": true, "congestion_balance_passes": 40,
            "congestion_balance_cross_weight": 0.5,
        });
        let merge = |extra: serde_json::Value| -> serde_json::Value {
            let mut o = base.as_object().cloned().unwrap_or_default();
            if let Some(e) = extra.as_object() {
                for (k, v) in e {
                    o.insert(k.clone(), v.clone());
                }
            }
            serde_json::Value::Object(o)
        };
        // (标签, 层数, 线宽, 线距, 覆盖项) —— 终选对照：11 层 / 0.1 / 0.1，阈值 4.8 + 热 SA + 护栏 2.5
        let chosen = serde_json::json!({
            "congestion_grid_cell": 2, "congestion_hard_threshold": 4.8, "layer_capacity": 1,
            "capacity_utilization": 0.6, "sector_angle_deg": 45, "method": "packing",
            "optimizer": "sa", "resolve_conflict_rounds": 15, "balance_length_rounds": 6,
            "minimize_crossings_passes": 6, "sa_restarts": 3, "sa_seed": 42,
            "sa_initial_temp": 20, "sa_cooling": 0.9998, "sa_max_steps": 0,
            "sa_swap_ratio": 0.9, "sa_balance_slack": 2.5, "via_area_cost": 0.1,
            "congestion_balance": true, "congestion_balance_passes": 40,
            "congestion_balance_cross_weight": 0.5,
        });
        let cfgs: Vec<(&str, i64, f64, f64, serde_json::Value)> = vec![
            (
                "J0 旧AC几何+DC式算参(阈值3.0 基线)",
                11,
                0.1,
                0.1,
                merge(serde_json::json!({ "congestion_hard_threshold": 3.0 })),
            ),
            (
                "J1 终选 AC 预设(阈值4.8+热SA+护栏2.5)",
                11,
                0.1,
                0.1,
                chosen.clone(),
            ),
            ("J2 终选复核(确定性)", 11, 0.1, 0.1, chosen.clone()),
        ];

        let mut cache: StdHashMap<(i64, i64, i64), LoadedData> = StdHashMap::new();
        for (label, layers, width, clearance, ov) in cfgs {
            let key = (layers, (width * 1000.0) as i64, (clearance * 1000.0) as i64);
            let data = cache
                .entry(key)
                .or_insert_with(|| {
                    crate::io::load_input(&input, &filters, layers, width, clearance).expect("读入应成功")
                })
                .clone();
            let cfg = default_config().with_overrides(&ov).expect("config 覆盖应成功");
            let prog = Progress::new(&active, &cancel);
            let t = std::time::Instant::now();
            let r = pipeline::run_once(&data, &cfg, &prog).expect("pipeline 应成功");
            let el = t.elapsed().as_secs_f64();

            let mut lc: crate::collections::HashMap<i64, i64> = crate::collections::HashMap::default();
            let mut llen: crate::collections::HashMap<i64, f64> = crate::collections::HashMap::default();
            let mut lsec: crate::collections::HashMap<i64, crate::collections::HashMap<i64, i64>> =
                crate::collections::HashMap::default();
            let mut sec_total: crate::collections::HashMap<i64, i64> = crate::collections::HashMap::default();
            let mut total = 0i64;
            for w in &data.wires {
                if let Some(&l) = r.assignment.get(&w.wire_id) {
                    *lc.entry(l).or_insert(0) += 1;
                    *llen.entry(l).or_insert(0.0) += w.length();
                    let si = metrics::sector_index(
                        crate::layer_packing::wire_dir_angle(w),
                        cfg.sector_angle_deg,
                    );
                    *lsec.entry(l).or_default().entry(si).or_insert(0) += 1;
                    *sec_total.entry(si).or_insert(0) += 1;
                    total += 1;
                }
            }
            let c_imb = metrics::count_imbalance(&lc);
            let l_imb = metrics::length_imbalance(&llen, &lc);
            let s_imb = metrics::sector_imbalance(&lsec, total);
            let same_cross: i64 = r.layers.iter().map(|l| l.soft_conflict_count).sum();
            let max_occ = r.layers.iter().fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
            let per_layer_sectors: Vec<String> = r
                .layers
                .iter()
                .filter(|l| l.kind == "signal")
                .map(|l| {
                    let n = lsec.get(&l.layer_index).map(|m| m.len()).unwrap_or(0);
                    format!("L{}:{}线/{}扇区", l.layer_index, l.wires.len(), n)
                })
                .collect();
            eprintln!(
                "[AC {label}]\n    nets={} wires={} 已分配={} 需人工={} 同层交叉={} 硬冲突(几何)={} 洪泛={}/{} 占用峰值={:.2}\n    层线数失衡={:.4} 层长失衡={:.4} 扇区失衡={:.4} 用时={:.1}s\n    {}",
                data.nets.len(),
                data.wires.len(),
                r.assignment.len(),
                r.manual_route_nets.len(),
                same_cross,
                r.hard_conflicts.len(),
                r.routable_flood_net_count,
                r.total_net_count,
                max_occ,
                c_imb,
                l_imb,
                s_imb,
                el,
                per_layer_sectors.join(" | ")
            );
        }
    }

    /// **DC 预设回归守护**（本地手工运行）：AC 预设标定**只改 `ui/App.vue` 的 `ac` 分支**
    /// （Rust 侧零行为改动），本测试用两份真实数据跑 DC 预设（4 层 / 0.2 / 0.2 / 阈值 3.0 + 质量优先）
    /// 并**锁定**结果，证明 DC 未被波及、且将来若有人改共享默认值会立刻报警。
    ///
    /// 基线（§1.16 / §1.22 的 hv 1800 网）：`已分配 1798 / 需人工 2`。
    ///
    /// 运行：`cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture real_data_dc_preset_regression`
    #[test]
    #[ignore]
    fn real_data_dc_preset_regression() {
        use crate::metrics;
        // 与 ui/App.vue 的 "hv"（DC 信号）预设逐字段一致
        let cfg = default_config()
            .with_overrides(&serde_json::json!({
                "congestion_grid_cell": 2, "congestion_hard_threshold": 3, "layer_capacity": 1,
                "capacity_utilization": 0.6, "sector_angle_deg": 45, "method": "packing",
                "optimizer": "sa", "resolve_conflict_rounds": 15, "balance_length_rounds": 6,
                "minimize_crossings_passes": 6, "sa_restarts": 3, "sa_seed": 42,
                "sa_initial_temp": 12, "sa_cooling": 0.9995, "sa_max_steps": 0,
                "sa_swap_ratio": 0.7, "sa_balance_slack": 2, "via_area_cost": 0.1,
                "congestion_balance": true, "congestion_balance_passes": 40,
                "congestion_balance_cross_weight": 0.5,
            }))
            .expect("config 覆盖应成功");
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();

        // 数据集 A：§1.16/§1.22 的 DC 基线（1800 网）；数据集 B：1165P + DC_VFSBLN_IN（单筛选文件）
        let a = r"D:\ToolBoxData\Project\测试";
        let b = r"D:\ToolBoxData\Project\1165P_3D";
        let cases: Vec<(&str, String, Vec<String>)> = vec![
            ("A 测试/1.xlsx + hv_all.lst", format!("{a}\\1.xlsx"), vec![format!("{a}\\hv_all.lst")]),
            (
                "B 1165P_3D_new.xlsx + DC_VFSBLN_IN.lst",
                format!("{b}\\1165P_3D_new.xlsx"),
                vec![format!("{b}\\LIST\\DC_VFSBLN_IN.lst")],
            ),
        ];
        let mut assigned_a = 0usize;
        let mut manual_a = 0usize;
        // 额外对照：同一 DC 预设但**关掉拥塞均衡**，用于说明均衡在 DC 上是否真的生效（不改 DC 配置）
        let mut no_bal = cfg.clone();
        no_bal.congestion_balance = false;
        for (label, input, filters) in cases {
            let data = crate::io::load_input(&input, &filters, 4, 0.2, 0.2).expect("读入应成功");
            for (tag, c) in [("均衡开", &cfg), ("均衡关", &no_bal)] {
                let prog = Progress::new(&active, &cancel);
                let t = std::time::Instant::now();
                let r = pipeline::run_once(&data, c, &prog).expect("pipeline 应成功");
                let el = t.elapsed().as_secs_f64();

                let mut lc: crate::collections::HashMap<i64, i64> = crate::collections::HashMap::default();
                let mut lsec: crate::collections::HashMap<i64, crate::collections::HashMap<i64, i64>> =
                    crate::collections::HashMap::default();
                let mut total = 0i64;
                for w in &data.wires {
                    if let Some(&l) = r.assignment.get(&w.wire_id) {
                        *lc.entry(l).or_insert(0) += 1;
                        let si = metrics::sector_index(
                            crate::layer_packing::wire_dir_angle(w),
                            c.sector_angle_deg,
                        );
                        *lsec.entry(l).or_default().entry(si).or_insert(0) += 1;
                        total += 1;
                    }
                }
                let max_occ = r.layers.iter().fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
                eprintln!(
                    "[DC 回归 {label} · {tag}] 网={} 已分配={} 需人工={} 同层交叉={} 洪泛={}/{} 占用峰值={:.2} 层线数失衡={:.4} 扇区失衡={:.4} 用时={:.2}s",
                    data.nets.len(),
                    r.assignment.len(),
                    r.manual_route_nets.len(),
                    r.layers.iter().map(|l| l.soft_conflict_count).sum::<i64>(),
                    r.routable_flood_net_count,
                    r.total_net_count,
                    max_occ,
                    metrics::count_imbalance(&lc),
                    metrics::sector_imbalance(&lsec, total),
                    el
                );
                if label.starts_with('A') && tag == "均衡开" {
                    assigned_a = r.assignment.len();
                    manual_a = r.manual_route_nets.len();
                }
            }
        }
        // §1.16/§1.22 记录的 DC 基线（1800 网 hv）：已分配 1798、需人工 2 —— 逐点锁定，防 DC 被波及
        assert_eq!(assigned_a, 1798, "DC 基线已分配数变了（DC 结果被波及）");
        assert_eq!(manual_a, 2, "DC 基线需人工数变了（DC 结果被波及）");
    }

    /// 对单个 PWR 名单真跑一遍分层（AC 预设几何/算参：11 层 / 0.1 / 0.1 + 阈值 4.8 + 热 SA + 护栏 2.5），
    /// 给出候选名单的"能不能分层 / 分了多少 / 需人工多少"结论。
    /// `cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture pwr_sense_layering`
    #[test]
    #[ignore]
    fn real_data_pwr_sense_layering() {
        let dir = r"D:\ToolBoxData\Project\1165P_3D";
        let input = format!("{dir}\\1165P_3D_new.xlsx");
        // AC 预设（ui/App.vue::applyPreset("ac") 的算法项）
        let ac = serde_json::json!({
            "congestion_grid_cell": 2, "congestion_hard_threshold": 4.8, "layer_capacity": 1,
            "capacity_utilization": 0.6, "sector_angle_deg": 45, "method": "packing",
            "optimizer": "sa", "resolve_conflict_rounds": 15, "balance_length_rounds": 6,
            "minimize_crossings_passes": 6, "sa_restarts": 3, "sa_seed": 42,
            "sa_initial_temp": 20, "sa_cooling": 0.9998, "sa_max_steps": 0,
            "sa_swap_ratio": 0.9, "sa_balance_slack": 2.5, "via_area_cost": 0.1,
            "congestion_balance": true, "congestion_balance_passes": 40,
            "congestion_balance_cross_weight": 0.5,
        });
        let cfg = default_config().with_overrides(&ac).expect("config 覆盖应成功");
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();
        for f in ["PWR_VDD1_SENSE.lst", "PWR_VDD1_IN.lst"] {
            let filter = format!("{dir}\\LIST\\{f}");
            let data = crate::io::load_input(&input, &[filter], 11, 0.1, 0.1).expect("读入应成功");
            let hist: std::collections::BTreeMap<usize, usize> =
                data.nets.iter().fold(std::collections::BTreeMap::new(), |mut m, n| {
                    *m.entry(n.pins.len()).or_insert(0) += 1;
                    m
                });
            let prog = Progress::new(&active, &cancel);
            let t = std::time::Instant::now();
            let r = pipeline::run_once(&data, &cfg, &prog).expect("pipeline 应成功");
            let same_cross: i64 = r.layers.iter().map(|l| l.soft_conflict_count).sum();
            let max_occ = r.layers.iter().fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
            let mut lc: crate::collections::HashMap<i64, i64> = crate::collections::HashMap::default();
            for w in &data.wires {
                if let Some(&l) = r.assignment.get(&w.wire_id) {
                    *lc.entry(l).or_insert(0) += 1;
                }
            }
            eprintln!(
                "[{f}] net={}（pin 数分布 {hist:?}）飞线={} 已分配={} 需人工={} 同层交叉={} 洪泛={}/{} 占用峰值={:.2} 层线数失衡={:.4} 用时={:.1}s",
                data.nets.len(),
                data.wires.len(),
                r.assignment.len(),
                r.manual_route_nets.len(),
                same_cross,
                r.routable_flood_net_count,
                r.total_net_count,
                max_occ,
                crate::metrics::count_imbalance(&lc),
                t.elapsed().as_secs_f64()
            );
        }
    }

    /// DC 预设 + "VDD1_SENSE ∪ DC_VFSBLN_IN" 组合跑分层（4 层 / 0.2 线宽 / 0.2 线距）。
    /// 回答"一个名单能否匹配 + 两名单合起来 4 层能不能装下、各层多少"。
    /// `cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture pwr_dc_layering`
    #[test]
    #[ignore]
    fn real_data_pwr_dc_layering() {
        let dir = r"D:\ToolBoxData\Project\1165P_3D";
        let input = format!("{dir}\\1165P_3D_new.xlsx");
        // DC（hv）预设：ui/App.vue::applyPreset("hv") 的全部算法项
        let dc = serde_json::json!({
            "congestion_grid_cell": 2, "congestion_hard_threshold": 3, "layer_capacity": 1,
            "capacity_utilization": 0.6, "sector_angle_deg": 45, "method": "packing",
            "optimizer": "sa", "resolve_conflict_rounds": 15, "balance_length_rounds": 6,
            "minimize_crossings_passes": 6, "sa_restarts": 3, "sa_seed": 42,
            "sa_initial_temp": 12, "sa_cooling": 0.9995, "sa_max_steps": 0,
            "sa_swap_ratio": 0.7, "sa_balance_slack": 2, "via_area_cost": 0.1,
            "congestion_balance": true, "congestion_balance_passes": 40,
            "congestion_balance_cross_weight": 0.5,
        });
        let cfg = default_config().with_overrides(&dc).expect("config 覆盖应成功");
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();
        let sense = format!("{dir}\\LIST\\PWR_VDD1_SENSE.lst");
        let vfsbln = format!("{dir}\\LIST\\DC_VFSBLN_IN.lst");

        let sets: Vec<(&str, Vec<String>)> = vec![
            ("组合：VDD1_SENSE ∪ DC_VFSBLN_IN", vec![sense.clone(), vfsbln.clone()]),
            ("单跑：VDD1_SENSE", vec![sense.clone()]),
            ("单跑：DC_VFSBLN_IN", vec![vfsbln.clone()]),
        ];

        for (label, filters) in sets {
            let data = crate::io::load_input(&input, &filters, 4, 0.2, 0.2).expect("读入应成功");
            let hist: std::collections::BTreeMap<usize, usize> =
                data.nets.iter().fold(std::collections::BTreeMap::new(), |mut m, n| {
                    *m.entry(n.pins.len()).or_insert(0) += 1;
                    m
                });
            // 各名单分别命中多少（对已加载的 net 集合取交集）
            let mut per_file: Vec<String> = Vec::new();
            for f in &filters {
                let wl = crate::io::xlsx::read_net_filter(f).unwrap();
                let hit = data
                    .nets
                    .iter()
                    .filter(|n| wl.contains(&n.net_id.to_uppercase()))
                    .count();
                let name = std::path::Path::new(f).file_name().unwrap().to_string_lossy().to_string();
                per_file.push(format!("{name}: 名单 {} 条 → 命中 {hit}", wl.len()));
            }
            let prog = Progress::new(&active, &cancel);
            let t = std::time::Instant::now();
            let r = pipeline::run_once(&data, &cfg, &prog).expect("pipeline 应成功");
            let same_cross: i64 = r.layers.iter().map(|l| l.soft_conflict_count).sum();
            let max_occ = r.layers.iter().fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
            let per_layer: Vec<String> = r
                .layers
                .iter()
                .filter(|l| l.kind == "signal")
                .map(|l| format!("L{}:{}线/交叉{}/峰值{:.2}", l.layer_index, l.wires.len(), l.soft_conflict_count, l.max_occupancy))
                .collect();
            eprintln!(
                "[{label}]\n    net={}（pin 数分布 {hist:?}）飞线={} 已分配={} 需人工={} 同层交叉={} 硬冲突(几何)={} 洪泛={}/{} 占用峰值={:.2} 用时={:.1}s\n    {}\n    warnings={:?}",
                data.nets.len(),
                data.wires.len(),
                r.assignment.len(),
                r.manual_route_nets.len(),
                same_cross,
                r.hard_conflicts.len(),
                r.routable_flood_net_count,
                r.total_net_count,
                max_occ,
                t.elapsed().as_secs_f64(),
                per_layer.join(" | "),
                data.warnings
            );
            eprintln!("    {}", per_file.join("；"));
        }

        // 组合场景再加几档"放宽约束/加减层"对照，用来看 4 层的**拥塞下限**（峰值由几何决定）
        for (tag, layers, mut c) in [
            ("组合·4 层（正式）", 4i64, cfg.clone()),
            ("组合·5 层", 5i64, cfg.clone()),
            ("组合·6 层", 6i64, cfg.clone()),
            ("组合·8 层", 8i64, cfg.clone()),
        ] {
            c.congestion_hard_threshold = cfg.congestion_hard_threshold;
            let data = crate::io::load_input(&input, &[sense.clone(), vfsbln.clone()], layers, 0.2, 0.2)
                .expect("读入应成功");
            let prog = Progress::new(&active, &cancel);
            let r = pipeline::run_once(&data, &c, &prog).expect("pipeline 应成功");
            let same_cross: i64 = r.layers.iter().map(|l| l.soft_conflict_count).sum();
            let max_occ = r.layers.iter().fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
            let mut lc: crate::collections::HashMap<i64, i64> = crate::collections::HashMap::default();
            for w in &data.wires {
                if let Some(&l) = r.assignment.get(&w.wire_id) {
                    *lc.entry(l).or_insert(0) += 1;
                }
            }
            eprintln!(
                "[{tag}] net={} 已分配={} 需人工={} 同层交叉={} 占用峰值={:.2} 层线数失衡={:.4} 洪泛={}/{}",
                data.nets.len(),
                r.assignment.len(),
                r.manual_route_nets.len(),
                same_cross,
                max_occ,
                crate::metrics::count_imbalance(&lc),
                r.routable_flood_net_count,
                r.total_net_count
            );
        }
        // 放宽单一约束的对照（说明峰值是几何下限）
        let data = crate::io::load_input(&input, &[sense.clone(), vfsbln.clone()], 4, 0.2, 0.2)
            .expect("读入应成功");
        for (tag, mut c) in [
            ("组合·放宽硬冲突阈值 12.0（4 层）", cfg.clone()),
            ("组合·放开层容量 10.0（4 层）", cfg.clone()),
        ] {
            if tag.contains("硬冲突阈值") {
                c.congestion_hard_threshold = 12.0;
            } else {
                c.layer_capacity = 10.0;
            }
            let prog = Progress::new(&active, &cancel);
            let r = pipeline::run_once(&data, &c, &prog).expect("pipeline 应成功");
            let same_cross: i64 = r.layers.iter().map(|l| l.soft_conflict_count).sum();
            let max_occ = r.layers.iter().fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
            eprintln!(
                "[{tag}] 已分配={} 需人工={} 同层交叉={} 占用峰值={:.2}",
                r.assignment.len(),
                r.manual_route_nets.len(),
                same_cross,
                max_occ
            );
        }
    }

    /// 统一指标收集：各层线数/交叉/峰值、层线数失衡、层长失衡、扇区失衡、跨层 net 数、过孔估算、走通率。
    /// 用于 DC/AC 参数扫描对比（见 `real_data_dc_quality_sweep`）。
    fn sweep_metrics(
        data: &LoadedData,
        r: &crate::model::LayeringResult,
        cfg: &crate::config::LayeringConfig,
    ) -> String {
        let mut lc: crate::collections::HashMap<i64, i64> = crate::collections::HashMap::default();
        let mut llen: crate::collections::HashMap<i64, f64> = crate::collections::HashMap::default();
        let mut lsec: crate::collections::HashMap<i64, crate::collections::HashMap<i64, i64>> =
            crate::collections::HashMap::default();
        let mut total = 0i64;
        for w in &data.wires {
            if let Some(&l) = r.assignment.get(&w.wire_id) {
                *lc.entry(l).or_insert(0) += 1;
                *llen.entry(l).or_insert(0.0) += w.length();
                let si = crate::metrics::sector_index(
                    crate::layer_packing::wire_dir_angle(w),
                    cfg.sector_angle_deg,
                );
                *lsec.entry(l).or_default().entry(si).or_insert(0) += 1;
                total += 1;
            }
        }
        let same_cross: i64 = r.layers.iter().map(|l| l.soft_conflict_count).sum();
        let max_occ = r
            .layers
            .iter()
            .fold(0.0f64, |m, l| if l.max_occupancy > m { l.max_occupancy } else { m });
        let per_layer: Vec<String> = r
            .layers
            .iter()
            .filter(|l| l.kind == "signal")
            .map(|l| format!("L{}:{}", l.layer_index, l.wires.len()))
            .collect();
        format!(
            "已分配={} 需人工={} 同层交叉={} 峰值={:.2} 层线数失衡={:.4} 层长失衡={:.4} 扇区失衡={:.4} 跨层net={} 过孔≈{} 洪泛={}/{} 各层[{}]",
            r.assignment.len(),
            r.manual_route_nets.len(),
            same_cross,
            max_occ,
            crate::metrics::count_imbalance(&lc),
            crate::metrics::length_imbalance(&llen, &lc),
            crate::metrics::sector_imbalance(&lsec, total),
            r.multi_layer_nets,
            r.via_estimate,
            r.routable_flood_net_count,
            r.total_net_count,
            per_layer.join(" ")
        )
    }

    /// DC 预设"分层质量"扫描：用户场景 = `VDD1_SENSE ∪ DC_VFSBLN_IN`（1280 net / 1362 飞线，4 层 / 0.2 / 0.2）。
    /// 目标：**每层均匀 + 同层交叉更少 + 需人工更少**。允许牺牲时间。
    /// 参考基线：`cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture real_data_dc_quality_sweep`
    #[test]
    #[ignore]
    fn real_data_dc_quality_sweep() {
        let dir = r"D:\ToolBoxData\Project\1165P_3D";
        let input = format!("{dir}\\1165P_3D_new.xlsx");
        let filters = vec![
            format!("{dir}\\LIST\\PWR_VDD1_SENSE.lst"),
            format!("{dir}\\LIST\\DC_VFSBLN_IN.lst"),
        ];
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();
        // DC 预设（ui/App.vue::applyPreset("hv")）逐项
        let dc = serde_json::json!({
            "congestion_grid_cell": 2, "congestion_hard_threshold": 3, "layer_capacity": 1,
            "capacity_utilization": 0.6, "sector_angle_deg": 45, "method": "packing",
            "optimizer": "sa", "resolve_conflict_rounds": 15, "balance_length_rounds": 6,
            "minimize_crossings_passes": 6, "sa_restarts": 3, "sa_seed": 42,
            "sa_initial_temp": 12, "sa_cooling": 0.9995, "sa_max_steps": 0,
            "sa_swap_ratio": 0.7, "sa_balance_slack": 2, "via_area_cost": 0.1,
            "congestion_balance": true, "congestion_balance_passes": 40,
            "congestion_balance_cross_weight": 0.5,
        });
        let merge = |extra: serde_json::Value| -> serde_json::Value {
            let mut o = dc.as_object().cloned().unwrap_or_default();
            if let Some(e) = extra.as_object() {
                for (k, v) in e {
                    o.insert(k.clone(), v.clone());
                }
            }
            serde_json::Value::Object(o)
        };
        // (标签, 层数, 覆盖项)
        let cases: Vec<(&str, i64, serde_json::Value)> = vec![
            ("T0 DC 现状基线", 4, dc.clone()),
            ("T1 初温 20", 4, merge(serde_json::json!({"sa_initial_temp": 20}))),
            ("T2 初温 40", 4, merge(serde_json::json!({"sa_initial_temp": 40}))),
            ("T3 慢冷却 0.9999", 4, merge(serde_json::json!({"sa_cooling": 0.9999}))),
            ("T4 热+慢（20/0.9999/0.9）", 4, merge(serde_json::json!({"sa_initial_temp": 20, "sa_cooling": 0.9999, "sa_swap_ratio": 0.9}))),
            ("T5 重启 10 + 初温 20", 4, merge(serde_json::json!({"sa_restarts": 10, "sa_initial_temp": 20}))),
            ("T6 交叉轮 20 + 消解 30", 4, merge(serde_json::json!({"minimize_crossings_passes": 20, "resolve_conflict_rounds": 30}))),
            ("T7 均衡 200 轮 + 交叉权重 1.0", 4, merge(serde_json::json!({"congestion_balance_passes": 200, "congestion_balance_cross_weight": 1.0}))),
            ("T8 阈值 4.8", 4, merge(serde_json::json!({"congestion_hard_threshold": 4.8}))),
            ("T9 阈值 6.0", 4, merge(serde_json::json!({"congestion_hard_threshold": 6.0}))),
            ("T10 阈值 4.8 + 热慢 SA + 均衡 200", 4, merge(serde_json::json!({
                "congestion_hard_threshold": 4.8, "sa_initial_temp": 20, "sa_cooling": 0.9999,
                "sa_swap_ratio": 0.9, "sa_restarts": 8, "congestion_balance_passes": 200,
                "congestion_balance_cross_weight": 1.0 }))),
            ("T11 同上 + 护栏 3.0", 4, merge(serde_json::json!({
                "congestion_hard_threshold": 4.8, "sa_initial_temp": 20, "sa_cooling": 0.9999,
                "sa_swap_ratio": 0.9, "sa_restarts": 8, "congestion_balance_passes": 200,
                "congestion_balance_cross_weight": 1.0, "sa_balance_slack": 3.0 }))),
            ("T12 6 层 + 阈值 4.8 + 热慢 SA", 6, merge(serde_json::json!({
                "congestion_hard_threshold": 4.8, "sa_initial_temp": 20, "sa_cooling": 0.9999,
                "sa_swap_ratio": 0.9, "sa_restarts": 8, "congestion_balance_passes": 200 }))),
        ];
        for (label, layers, ov) in cases {
            let cfg = default_config().with_overrides(&ov).expect("config 覆盖应成功");
            let data = crate::io::load_input(&input, &filters, layers, 0.2, 0.2).expect("读入应成功");
            let prog = Progress::new(&active, &cancel);
            let t = std::time::Instant::now();
            let r = pipeline::run_once(&data, &cfg, &prog).expect("pipeline 应成功");
            eprintln!(
                "[{label}] {} 用时={:.1}s",
                sweep_metrics(&data, &r, &cfg),
                t.elapsed().as_secs_f64()
            );
        }
    }

    /// 同一 net 的 2 段线（3-pin net）是否同层：`same_net_same_layer`（硬整网）与
    /// `same_net_via_penalty`（软偏好 + 段级兜底）在真实数据上的效果对比。
    /// `cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture same_net_layer_sweep`
    #[test]
    #[ignore]
    fn real_data_same_net_layer_sweep() {
        let dir = r"D:\ToolBoxData\Project\1165P_3D";
        let input = format!("{dir}\\1165P_3D_new.xlsx");
        let filters = vec![
            format!("{dir}\\LIST\\PWR_VDD1_SENSE.lst"),
            format!("{dir}\\LIST\\DC_VFSBLN_IN.lst"),
        ];
        let active = Arc::new(Mutex::new(ActiveStateData::default()));
        let cancel = new_cancel();
        let dc = serde_json::json!({
            "congestion_grid_cell": 2, "congestion_hard_threshold": 3, "layer_capacity": 1,
            "capacity_utilization": 0.6, "sector_angle_deg": 45, "method": "packing",
            "optimizer": "sa", "resolve_conflict_rounds": 15, "balance_length_rounds": 6,
            "minimize_crossings_passes": 6, "sa_restarts": 3, "sa_seed": 42,
            "sa_initial_temp": 12, "sa_cooling": 0.9995, "sa_max_steps": 0,
            "sa_swap_ratio": 0.7, "sa_balance_slack": 2, "via_area_cost": 0.1,
            "congestion_balance": true, "congestion_balance_passes": 40,
            "congestion_balance_cross_weight": 0.5,
        });
        for layers in [4i64, 6] {
            let data = crate::io::load_input(&input, &filters, layers, 0.2, 0.2).expect("读入应成功");
            // 多段网（>1 根飞线）总览
            let mut per_net: crate::collections::HashMap<String, usize> = crate::collections::HashMap::default();
            for w in &data.wires {
                *per_net.entry(w.net_id.clone()).or_insert(0) += 1;
            }
            let multi = per_net.values().filter(|&&c| c > 1).count();
            let multi_wires: usize = per_net.values().filter(|&&c| c > 1).sum();
            eprintln!(
                "[{layers} 层] 飞线 {} 条；多段网 {multi} 个（共 {multi_wires} 条线，占 {:.0}%）",
                data.wires.len(),
                100.0 * multi_wires as f64 / data.wires.len() as f64
            );
            for (label, same_layer, via_penalty, consolidate, merge_slack) in [
                ("改动前基线（无归层）", false, 0.0f64, false, 1.15f64),
                ("整网归层 开（新默认）", false, 0.0, true, 1.15),
                ("整网归层 + 软偏好 λ=1", false, 1.0, true, 1.15),
                ("整网归层 + 硬整网 packing", true, 0.0, true, 1.15),
                ("整网归层 + 上限放宽 1.5", false, 0.0, true, 1.5),
            ] {
                let mut cfg = default_config().with_overrides(&dc).expect("config 覆盖应成功");
                cfg.same_net_same_layer = same_layer;
                cfg.same_net_via_penalty = via_penalty;
                cfg.same_net_consolidate = consolidate;
                cfg.same_net_merge_slack = merge_slack;
                let prog = Progress::new(&active, &cancel);
                let t = std::time::Instant::now();
                let r = pipeline::run_once(&data, &cfg, &prog).expect("pipeline 应成功");
                // 同 net 拆层统计（只看多段网）
                let mut net_layers: crate::collections::HashMap<String, crate::collections::HashSet<i64>> =
                    crate::collections::HashMap::default();
                for w in &data.wires {
                    if let Some(&l) = r.assignment.get(&w.wire_id) {
                        net_layers.entry(w.net_id.clone()).or_default().insert(l);
                    }
                }
                let split = net_layers
                    .iter()
                    .filter(|(n, ls)| per_net.get(*n).copied().unwrap_or(0) > 1 && ls.len() > 1)
                    .count();
                eprintln!(
                    "  [{label}] {} 同net拆层={split}/{multi} 用时={:.1}s",
                    sweep_metrics(&data, &r, &cfg),
                    t.elapsed().as_secs_f64()
                );
            }
        }
    }

    /// 诊断：逐个 PWR 筛选文件读入，打印"白名单条数 / 命中 net 数 / pin 数分布 / 未匹配条数"。
    /// 用于排查"筛选文件里的 net 没被识别/没被分层"（本地手工跑，需要真实数据）：
    /// `cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture pwr_filter_diagnose`
    #[test]
    #[ignore]
    fn real_data_pwr_filter_diagnose() {
        let dir = r"D:\ToolBoxData\Project\1165P_3D";
        let input = format!("{dir}\\1165P_3D_new.xlsx");
        let files = [
            "PWR_VDD1_SENSE.lst",
            "PWR_VDD1_IN.lst",
            "PWR_VDD2_Force.lst",
            "PWR_VDD2_Sense.lst",
            "PWR_UtiL.lst",
        ];
        for f in files {
            let path = format!("{dir}\\LIST\\{f}");
            let wl = crate::io::xlsx::read_net_filter(&path).unwrap();
            let data = match crate::io::load_input(&input, &[path], 4, 0.2, 0.2) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[{f}] 读入失败: {e}");
                    continue;
                }
            };
            let mut hist: std::collections::BTreeMap<usize, usize> = std::collections::BTreeMap::new();
            for n in &data.nets {
                *hist.entry(n.pins.len()).or_insert(0) += 1;
            }
            let matched: std::collections::HashSet<String> =
                data.nets.iter().map(|n| n.net_id.to_uppercase()).collect();
            let unmatched: Vec<&String> = wl.iter().filter(|k| !matched.contains(*k)).take(4).collect();
            eprintln!(
                "[{f}] 白名单 {} 条 → 命中 net {} / 飞线 {}；pin 数分布 {hist:?}；未匹配示例 {unmatched:?}",
                wl.len(),
                data.nets.len(),
                data.wires.len()
            );
            eprintln!("        warnings: {:?}", data.warnings);
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
