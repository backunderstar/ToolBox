//! 插件系统：清单发现、注册表、生命周期（启用/禁用/热重载/崩溃重启）。
//!
//! 结构（2026-08 拆分，原 1935 行单文件）：
//! - `manager`：PluginManager 核心（发现/启停/卸载/安装）与工具函数
//! - `commands`：全部 IPC 命令（tauri::command 层）
//! - `manifest` / `native` / `process` / `events`：类型与运行时。
//!   本文件保留模块声明、re-export（lib.rs 沿用 `plugins::*` 路径）与集成测试。

pub mod commands;
pub mod events;
pub mod manager;
pub mod manifest;
pub mod native;
pub mod process;

// re-export：lib.rs 的 State<PluginManager> 沿用 plugins::* 路径
pub use manager::PluginManager;
// 打包版核心插件部署（仅 release 存在——manager.rs 同款 cfg；dev 由 build:core 管理，
// 此处不 re-export 避免 dev 下引用不存在的项）
#[cfg(not(dev))]
pub use manager::ensure_core_plugins;
// 以下 re-export 仅集成测试需要（tests 模块的 `use super::*` 拉取；
// 非测试编译不产生，避免 unused 警告）
#[cfg(test)]
pub(crate) use manager::{
    deploy_core_plugins, is_safe_plugin_id, migrate_vault_plugins, PluginRecord,
};
#[cfg(test)]
pub(crate) use manifest::{PluginManifest, PluginRuntime};
#[cfg(test)]
pub(crate) use native::NativePlugin;
#[cfg(test)]
pub(crate) use process::ProcessPlugin;
// 测试模块直接使用的 std 类型（原单文件时由模块顶部 use 提供）
#[cfg(test)]
pub(crate) use std::collections::HashSet;
#[cfg(test)]
pub(crate) use std::path::{Path, PathBuf};
#[cfg(test)]
pub(crate) use std::time::{Duration, Instant};

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::Message;
    use serde_json::json;
    use std::sync::mpsc::channel;

    /// 插件 id 白名单（S1a 第一道闸）：合法 id 通过，穿越/绝对路径/非法字符拒绝。
    #[test]
    fn safe_plugin_id_validation() {
        for ok in ["core-notes", "a", "a1", "text-stats", "theme-maple", "x-y2"] {
            assert!(is_safe_plugin_id(ok), "{ok} 应合法");
        }
        for bad in [
            "", ".", "..", "../evil", "..\\evil", "/abs", "C:/evil", "a/b", "a b", "-lead",
            "UPPER", "中文", "a..b", "my_plugin", "x-y_z2",
        ] {
            assert!(!is_safe_plugin_id(bad), "{bad:?} 应非法");
        }
    }

    /// native 运行时只允许 _core 目录（S1b）：外部目录的 native 插件拒绝启动。
    #[test]
    fn start_native_rejects_non_core_dir() {
        let mut m = PluginManager {
            vault: Some(PathBuf::from("C:/vault")),
            ..Default::default()
        };
        m.records.push(PluginRecord {
            manifest: PluginManifest {
                id: "evil".into(),
                name: "evil".into(),
                version: "0.1.0".into(),
                runtime: PluginRuntime::Native,
                entry: None,
                command: Some(vec!["evil.dll".into()]),
                permissions: Vec::new(),
                description: String::new(),
                config: serde_json::Value::Null,
                search_provider: false,
                system: false,
                ui: None,
                nav: Vec::new(),
                theme: None,
            },
            // 目录在插件根之外（父目录不是 _core）
            dir: PathBuf::from("C:/outside/plugins/evil"),
            commands: Vec::new(),
            error: None,
            process: None,
            native: None,
            restarts: 0,
            last_crash: None,
        });
        let err = m.start_native(0).unwrap_err();
        assert!(err.contains("不在核心插件目录"), "应拒绝外部 native 插件: {err}");
    }

    /// native 运行时 _core 目录放行（S1b 正向）：核心插件仍能正常加载。
    /// 需要已构建 tb_notes.dll（cargo build -p tb-notes），否则跳过。
    #[test]
    fn start_native_accepts_core_dir() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tb_notes.dll");
        if !dll.exists() {
            eprintln!("[skip] 请先构建核心插件: cargo build -p tb-notes");
            return;
        }
        let base = std::env::temp_dir().join(format!("tb-native-core-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        // 模拟 plugins/_core/core-notes/（含 DLL）
        let core_dir = base.join("plugins/_core/core-notes");
        std::fs::create_dir_all(&core_dir).unwrap();
        std::fs::copy(&dll, core_dir.join("tb_notes.dll")).unwrap();

        let mut m = PluginManager {
            vault: Some(PathBuf::from("C:/vault")),
            config_dir: Some(base.to_string_lossy().to_string()),
            ..Default::default()
        };
        m.records.push(PluginRecord {
            manifest: PluginManifest {
                id: "core-notes".into(),
                name: "笔记".into(),
                version: "0.1.0".into(),
                runtime: PluginRuntime::Native,
                entry: None,
                command: Some(vec!["tb_notes.dll".into()]),
                permissions: Vec::new(),
                description: String::new(),
                config: serde_json::Value::Null,
                search_provider: false,
                system: false,
                ui: None,
                nav: Vec::new(),
                theme: None,
            },
            dir: core_dir,
            commands: Vec::new(),
            error: None,
            process: None,
            native: None,
            restarts: 0,
            last_crash: None,
        });
        m.start_native(0).expect("_core 下的 native 插件应能启动");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A6 回归：核心插件**首次扫描**（records 为空）时 native 判定不依赖 records，
    /// 应立即启动（native 实例非 None）。历史 bug：plugin_enabled 靠 records 判断
    /// native，而 scan 在 push 之前调用它，导致首次刷新核心插件全部 stopped。
    #[test]
    fn scan_starts_native_on_first_pass() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tb_notes.dll");
        if !dll.exists() {
            eprintln!("[skip] 请先构建核心插件: cargo build -p tb-notes");
            return;
        }
        let base = std::env::temp_dir().join(format!("tb-scan-native-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let core_dir = base.join("plugins/_core/core-notes");
        std::fs::create_dir_all(&core_dir).unwrap();
        std::fs::copy(&dll, core_dir.join("tb_notes.dll")).unwrap();
        std::fs::write(
            core_dir.join("plugin.json"),
            serde_json::json!({
                "id": "core-notes",
                "name": "笔记",
                "version": "0.1.0",
                "runtime": "native",
                "command": ["tb_notes.dll"]
            })
            .to_string(),
        )
        .unwrap();

        let mut m = PluginManager {
            vault: Some(PathBuf::from("C:/vault")),
            config_dir: Some(base.to_string_lossy().to_string()),
            ..Default::default()
        };
        m.scan_plugin_dir(&core_dir); // records 为空时的首次扫描
        assert_eq!(m.records.len(), 1);
        assert!(m.records[0].native.is_some(), "首次扫描即应启动 native 插件");
        assert!(m.records[0].error.is_none(), "不应有启动错误");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 打包资源部署：src（模拟 resource_dir/_core）→ dst，清空后整体复制。
    #[test]
    fn deploy_core_plugins_copies_tree() {
        let base = std::env::temp_dir().join(format!("tb-deploy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src/_core");
        std::fs::create_dir_all(src.join("core-notes")).unwrap();
        std::fs::write(src.join("core-notes/plugin.json"), "{}").unwrap();
        std::fs::write(src.join("core-notes/tb_notes.dll"), "dll-bytes").unwrap();
        std::fs::create_dir_all(src.join("core-blog")).unwrap();
        std::fs::write(src.join("core-blog/plugin.json"), "{}").unwrap();

        let dst = base.join("dst/_core");
        // 已卸载的插件（removed_core）跳过部署
        let removed = HashSet::from(["core-blog".to_string()]);
        deploy_core_plugins(&src, &dst, &removed).unwrap();
        assert!(dst.join("core-notes/plugin.json").is_file());
        assert!(dst.join("core-notes/tb_notes.dll").is_file());
        assert!(!dst.join("core-blog/plugin.json").exists(), "已卸载插件应跳过部署");

        // 重复部署 + 手动安装的本地插件保留：
        // 用户把 DLL 插件目录放入 _core 后，随包部署不清空它（重启后仍可用）
        std::fs::write(dst.join("core-notes/plugin.json"), "{}").unwrap();
        std::fs::create_dir_all(dst.join("core-mine")).unwrap();
        std::fs::write(dst.join("core-mine/plugin.json"), "{}").unwrap();
        std::fs::write(dst.join("core-mine/tb_mine.dll"), "dll").unwrap();
        std::fs::write(dst.join("stale.txt"), "old").unwrap();
        deploy_core_plugins(&src, &dst, &HashSet::new()).unwrap();
        assert!(
            dst.join("core-mine/plugin.json").is_file(),
            "用户手动安装的插件应保留（不清空 _core）"
        );
        assert!(dst.join("core-mine/tb_mine.dll").is_file());
        assert!(dst.join("core-blog/plugin.json").is_file(), "清除标记后恢复部署");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 原生核心插件全链路：真实 DLL 加载 → create → notes CRUD。
    /// 需要先构建核心插件（`cargo build -p tb-notes`），DLL 不存在时跳过。
    #[test]
    fn native_plugin_load_and_call() {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/tb_notes.dll");
        if !dll.exists() {
            eprintln!("[skip] 请先构建核心插件: cargo build -p tb-notes");
            return;
        }
        let base = std::env::temp_dir().join(format!("tb-native-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let vault = base.join("vault");
        std::fs::create_dir_all(vault.join("notes")).unwrap();

        let cfg = json!({ "vault": vault.to_string_lossy() }).to_string();
        let plugin = NativePlugin::load(&dll, "core-notes", &cfg).expect("DLL 应能加载");

        // 新建
        plugin.call("notes.create", &json!({ "rel": "notes/测试.md" })).unwrap();
        assert!(vault.join("notes/测试.md").exists(), "文件应创建");

        // 写入 + 读取
        plugin.call("notes.write", &json!({ "rel": "notes/测试.md", "content": "# 你好\n" })).unwrap();
        let content = plugin.call("notes.read", &json!({ "rel": "notes/测试.md" })).unwrap();
        assert_eq!(content, "# 你好\n");

        // 重命名
        plugin.call("notes.rename", &json!({ "from": "notes/测试.md", "to": "notes/改名.md" })).unwrap();
        assert!(!vault.join("notes/测试.md").exists());
        assert!(vault.join("notes/改名.md").exists());

        // 列表
        let list = plugin.call("notes.list", &json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 1, "应只剩改名后的笔记");

        // 删除
        plugin.call("notes.delete", &json!({ "rel": "notes/改名.md" })).unwrap();
        assert!(plugin.call("notes.list", &json!({})).unwrap().as_array().unwrap().is_empty());

        // 未知命令 → 错误
        let err = plugin.call("no.such", &json!({})).unwrap_err();
        assert!(err.contains("未知命令"), "错误信息: {err}");

        drop(plugin);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 旧布局迁移：vault/plugins/* → 全局目录（复制 + 整体回收站清理）。
    #[test]
    fn migrate_vault_plugins_copies_and_cleans() {
        let base = std::env::temp_dir().join(format!("tb-plugin-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let vault = base.join("vault");
        let global = base.join("global-plugins");
        std::fs::create_dir_all(vault.join("plugins/a-plugin")).unwrap();
        std::fs::write(
            vault.join("plugins/a-plugin/plugin.json"),
            r#"{"id":"a-plugin","name":"A","version":"0.1.0","runtime":"process","command":["python","main.py"]}"#,
        )
        .unwrap();
        std::fs::write(vault.join("plugins/a-plugin/main.py"), "print('hi')").unwrap();
        // 无清单的目录不迁移
        std::fs::create_dir_all(vault.join("plugins/not-a-plugin")).unwrap();
        std::fs::write(vault.join("plugins/not-a-plugin/readme.txt"), "x").unwrap();

        let n = migrate_vault_plugins(&vault, &global).unwrap();
        assert_eq!(n, 1, "只迁移含清单的插件");
        assert!(global.join("a-plugin/plugin.json").is_file(), "插件应复制到全局");
        assert!(!vault.join("plugins").exists(), "vault/plugins 应整体进回收站");

        // 幂等：vault/plugins 已不存在 → 无事可做
        assert_eq!(migrate_vault_plugins(&vault, &global).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 全局已有同 id 时保留全局版本（vault 版本丢弃）。
    #[test]
    fn migrate_skips_existing_global_id() {
        let base = std::env::temp_dir().join(format!("tb-plugin-migrate2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let vault = base.join("vault");
        let global = base.join("global-plugins");
        std::fs::create_dir_all(vault.join("plugins/dup")).unwrap();
        std::fs::write(
            vault.join("plugins/dup/plugin.json"),
            r#"{"id":"dup","name":"旧","version":"0.0.1","runtime":"webview","entry":"main.js"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(global.join("dup")).unwrap();
        std::fs::write(global.join("dup/plugin.json"), "全局版本").unwrap();

        let n = migrate_vault_plugins(&vault, &global).unwrap();
        assert_eq!(n, 1);
        let g = std::fs::read_to_string(global.join("dup/plugin.json")).unwrap();
        assert_eq!(g, "全局版本", "不应覆盖已有全局插件");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn manifest_validation() {
        let ok: PluginManifest = serde_json::from_value(json!({
            "id": "csv-tool", "name": "CSV 工具", "version": "0.1.0",
            "runtime": "process", "command": ["python", "main.py"]
        }))
        .unwrap();
        assert!(ok.validate().is_ok());

        let bad_id: PluginManifest = serde_json::from_value(json!({
            "id": "Bad ID!", "name": "x", "version": "0.1.0",
            "runtime": "process", "command": ["python"]
        }))
        .unwrap();
        assert!(bad_id.validate().is_err());

        let missing_entry: PluginManifest = serde_json::from_value(json!({
            "id": "js-x", "name": "x", "version": "0.1.0", "runtime": "webview"
        }))
        .unwrap();
        assert!(missing_entry.validate().is_err());

        // 皮肤插件：webview + 声明 theme 时允许无 entry（纯数据包）
        let theme_ok: PluginManifest = serde_json::from_value(json!({
            "id": "theme-x", "name": "x", "version": "0.1.0", "runtime": "webview",
            "theme": { "base": "light", "tokens": { "--accent": "#c0392b" }, "css": "theme.css",
                       "preview": ["#faf5f0", "#a8402c", "#2b211c"] }
        }))
        .unwrap();
        assert!(theme_ok.validate().is_ok());

        // 主题 base 非法拒绝
        let theme_bad_base: PluginManifest = serde_json::from_value(json!({
            "id": "theme-x", "name": "x", "version": "0.1.0", "runtime": "webview",
            "theme": { "base": "blue" }
        }))
        .unwrap();
        assert!(theme_bad_base.validate().is_err());

        // theme 字段序列化回环（前端拿到 camelCase base/tokens/css/preview）
        let back: PluginManifest = serde_json::from_value(serde_json::to_value(&theme_ok).unwrap()).unwrap();
        let t = back.theme.as_ref().expect("theme 应保留");
        assert_eq!(t.base, "light");
        assert_eq!(t.tokens.get("--accent").map(String::as_str), Some("#c0392b"));
        assert_eq!(t.css.as_deref(), Some("theme.css"));
        assert_eq!(
            t.preview.as_deref(),
            Some(&["#faf5f0".to_string(), "#a8402c".to_string(), "#2b211c".to_string()][..])
        );
    }

    #[test]
    fn rpc_message_roundtrip() {
        let req = Message::request(1, "call", json!({"command": "a", "args": {}}));
        let line = crate::rpc::encode(&req).unwrap();
        let parsed = crate::rpc::decode(line.trim()).unwrap();
        match parsed {
            Message::Request { id, method, params } => {
                assert_eq!(id, 1);
                assert_eq!(method, "call");
                assert!(params.is_some());
            }
            _ => panic!("应为 Request"),
        }
        let resp = Message::response_ok(2, json!({"ok": true}));
        let line = crate::rpc::encode(&resp).unwrap();
        match crate::rpc::decode(line.trim()).unwrap() {
            Message::Response { id, result, error } => {
                assert_eq!(id, 2);
                assert!(result.is_some());
                assert!(error.is_none());
            }
            _ => panic!("应为 Response"),
        }
    }

    /// 桥接回环：用仓库里的 csv-tool（真实 Python 进程）走完整 JSON-RPC。
    #[test]
    fn bridge_roundtrip_with_python() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let plugin_dir = base.join("plugins").join("csv-tool");
        let manifest_raw =
            std::fs::read_to_string(plugin_dir.join("plugin.json")).expect("示例插件应存在");
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        let cmd = m.command.clone().unwrap();
        let vault = std::env::temp_dir();
        let perms = m.permissions.clone();
        let mut p = ProcessPlugin::spawn(
            &m.id,
            &cmd[0],
            &cmd[1..],
            &plugin_dir,
            &vault,
            perms,
            channel().0,
        )
        .expect("应能启动 python 进程");
        let commands = p.init(Duration::from_secs(15)).unwrap();
        assert!(
            commands.contains(&"csv.convert".to_string()),
            "init 应返回 csv.convert"
        );

        let res = p
            .call(
                "csv.convert",
                json!({ "csv": "a,b\n1,2\n3,4", "format": "json" }),
                Duration::from_secs(15),
            )
            .unwrap();
        let text = res["text"].as_str().expect("结果应有 text");
        assert!(text.contains("\"a\": \"1\""), "JSON 转换结果: {text}");

        let res2 = p
            .call(
                "csv.convert",
                json!({ "csv": "a,b\n1,2", "format": "tsv" }),
                Duration::from_secs(15),
            )
            .unwrap();
        assert!(res2["text"].as_str().unwrap().contains("a\tb"));
        p.shutdown();
    }

    /// 事件桥：csv-tool 的 csv.eventTest 发 Notification → 事件总线收到
    /// （ProcessPlugin 只持 mpsc Sender，不接触 tauri 类型——规避历史加载崩溃）。
    #[test]
    fn bridge_event_forward() {
        use crate::plugins::events::PluginEvent;
        use std::sync::mpsc::channel;
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let plugin_dir = base.join("plugins").join("csv-tool");
        let manifest_raw =
            std::fs::read_to_string(plugin_dir.join("plugin.json")).expect("示例插件应存在");
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        let cmd = m.command.clone().unwrap();
        let vault = std::env::temp_dir();
        let (event_tx, event_rx) = channel::<PluginEvent>();
        let mut p = ProcessPlugin::spawn(
            &m.id,
            &cmd[0],
            &cmd[1..],
            &plugin_dir,
            &vault,
            m.permissions.clone(),
            event_tx,
        )
        .expect("应能启动 python 进程");
        p.init(Duration::from_secs(15)).unwrap();
        let res = p
            .call(
                "csv.eventTest",
                json!({ "percent": 60 }),
                Duration::from_secs(15),
            )
            .unwrap();
        assert!(
            res["text"].as_str().unwrap().contains("3 个进度事件"),
            "结果: {res}"
        );
        // 应收到 3 个 progress 事件（调用期间实时转发）
        let ev = event_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(ev.plugin_id, "csv-tool");
        assert_eq!(ev.event, "progress");
        assert_eq!(ev.data["percent"], 20);
        assert_eq!(
            event_rx.try_iter().count(),
            2,
            "还应有剩余 2 个事件"
        );
        p.shutdown();
    }

    /// 错误路径：未知命令应返回插件错误（RPC error 透传）。
    #[test]
    fn bridge_error_path() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let plugin_dir = base.join("plugins").join("csv-tool");
        let manifest_raw =
            std::fs::read_to_string(plugin_dir.join("plugin.json")).expect("示例插件应存在");
        let m: PluginManifest = serde_json::from_str(&manifest_raw).unwrap();
        let cmd = m.command.clone().unwrap();
        let vault = std::env::temp_dir();
        let perms = m.permissions.clone();
        let mut p = ProcessPlugin::spawn(
            &m.id,
            &cmd[0],
            &cmd[1..],
            &plugin_dir,
            &vault,
            perms,
            channel().0,
        )
        .unwrap();
        p.init(Duration::from_secs(15)).unwrap();
        let err = p
            .call(
                "csv.no-such-command",
                json!({}),
                Duration::from_secs(15),
            )
            .unwrap_err();
        assert!(err.contains("未知命令") || err.contains("unknown"), "错误信息: {err}");
        p.shutdown();
    }

    /// 超时：插件无响应时应返回超时错误。
    #[test]
    fn bridge_timeout() {
        let vault = std::env::temp_dir();
        let mut p = ProcessPlugin::spawn(
            "sleepy",
            "python",
            &["-c".to_string(), "import time; time.sleep(5)".to_string()],
            &vault,
            &vault,
            vec![],
            channel().0,
        )
        .expect("应能启动 python");
        let err = p.init(Duration::from_millis(800)).unwrap_err();
        assert!(err.contains("超时") || err.contains("timeout"), "错误信息: {err}");
        p.shutdown();
    }

    /// stdin 写入超时：插件不读 stdin（挂死），管道缓冲写满后
    /// 写入不得无限阻塞——应超时返回错误并终止进程。
    #[test]
    fn stdin_write_timeout_kills_hung_plugin() {
        let vault = std::env::temp_dir();
        let mut p = ProcessPlugin::spawn(
            "hung",
            "python",
            &[
                "-u".to_string(),
                "-c".to_string(),
                "import time; time.sleep(60)".to_string(),
            ],
            &vault,
            &vault,
            vec![],
            channel().0,
        )
        .expect("应能启动 python");
        // 大载荷（远超管道缓冲）写入无人消费的 stdin → 写线程阻塞
        let big = json!({ "payload": "x".repeat(256 * 1024) });
        let t0 = Instant::now();
        let err = p
            .send_timeout(
                &Message::request(1, "call", big),
                Duration::from_millis(800),
            )
            .unwrap_err();
        let elapsed = t0.elapsed();
        assert!(
            err.contains("超时") || err.contains("stdin") || err.contains("挂死"),
            "错误信息: {err}"
        );
        assert!(
            elapsed < Duration::from_secs(10),
            "写入不应无限阻塞，实际 {elapsed:?}"
        );
        // kill 是异步的：轮询等待进程被系统回收
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut exited = false;
        while Instant::now() < deadline {
            if p.has_exited() {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(exited, "挂死插件应被终止");
        p.shutdown();
    }
}

