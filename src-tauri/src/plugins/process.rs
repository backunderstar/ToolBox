//! 进程插件桥：子进程 + JSON-RPC over stdio。
//!
//! - 独立读线程把插件 stdout 的行解析为 `Incoming` 消息送入 mpsc 通道
//! - `call` 支持超时；期间插件可反向调用核心 API（fs.readText / fs.writeText / log）
//! - 崩溃/退出通过 `Eof` 信号检测，由上层管理器决定是否重启

use crate::core::path::resolve_safe;
use crate::plugins::events::PluginEvent;
use crate::rpc::{self, Message, RpcError};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// 来自插件进程的入站消息。
pub enum Incoming {
    Response {
        id: u64,
        result: Option<Value>,
        error: Option<RpcError>,
    },
    /// 插件请求调用核心 API
    Request {
        id: u64,
        method: String,
        params: Value,
    },
    /// 事件 / 通知
    Event {
        event: String,
        data: Value,
    },
    /// stdout 已关闭（进程退出或崩溃）
    Eof,
}

/// 写线程请求：把一条消息写入插件 stdin 并回执结果。
/// stdin 由写线程独占——主线程若直接 `write_all`，插件不读 stdin 时
/// 管道缓冲写满会**无限阻塞**；走线程 + 通道才能带超时回收。
enum WriteReq {
    Send {
        bytes: Vec<u8>,
        ack: Sender<Result<(), String>>,
    },
    Shutdown,
}

pub struct ProcessPlugin {
    child: Child,
    /// 写线程通道：所有出站消息经它写入 stdin
    write_tx: Sender<WriteReq>,
    /// mpsc Receiver 非 Sync，包一层 Mutex 以满足 tauri 状态要求
    rx: Mutex<Receiver<Incoming>>,
    next_id: u64,
    vault: PathBuf,
    /// 文件输入（Inbox，数据根/Input）目录：插件可**只读**它（fs.readText/listDir 允许
    /// 其下的绝对路径；写操作仍限 vault）。None = 未配置数据根。
    inbox: Option<PathBuf>,
    /// 插件声明的权限（execute_core_api 据此放行核心 API）
    permissions: Vec<String>,
    pub plugin_id: String,
    /// 事件桥：插件 Notification → 前端（纯 mpsc，不接触 tauri 类型）。
    /// 用 SyncSender（有界）：失控进程无限推事件时背压到读线程，不占无限内存
    event_tx: SyncSender<PluginEvent>,
    /// stderr 捕获：最近若干行（Python traceback / 缺依赖原因），init 失败时回显。
    /// 独立读线程持续消费，否则 Windows 管道缓冲写满会阻塞插件进程。
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl ProcessPlugin {
    /// 启动插件进程（cwd = 插件目录，便于脚本用相对路径）。
    /// 注入 `TB_WORKSPACE` 环境变量 = 当前工作区路径：多工作区模式下插件
    /// 进程无需感知切换，读 env 即可按"当前工作区"读写文件（见插件开发指南）；
    /// `inbox` = 文件输入（Inbox）目录（可只读，经 `TB_INBOX` 注入），None = 未配置数据根。
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        plugin_id: &str,
        program: &str,
        args: &[String],
        plugin_dir: &Path,
        vault: &Path,
        inbox: Option<&Path>,
        permissions: Vec<String>,
        event_tx: SyncSender<PluginEvent>,
    ) -> Result<Self, String> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .current_dir(plugin_dir)
            .env("TB_WORKSPACE", vault);
        if let Some(inbox) = inbox {
            cmd.env("TB_INBOX", inbox);
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()) // 捕获：读线程转发日志 + 保留末尾，init 失败时回显
            .spawn()
            .map_err(|e| format!("启动插件进程失败（{program}）: {e}"))?;
        let stdin = child.stdin.take().ok_or("无法获取插件 stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取插件 stdout")?;
        let stderr = child.stderr.take().ok_or("无法获取插件 stderr")?;
        let (tx, rx) = channel();
        thread::spawn(move || read_loop(stdout, tx));
        let write_tx = spawn_write_thread(stdin);
        // stderr 读线程：必须持续读（不读会写满管道缓冲阻塞插件进程）
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        {
            let tail = Arc::clone(&stderr_tail);
            thread::spawn(move || read_stderr_loop(stderr, tail));
        }
        Ok(Self {
            child,
            write_tx,
            rx: Mutex::new(rx),
            next_id: 0,
            vault: vault.to_path_buf(),
            inbox: inbox.map(|p| p.to_path_buf()),
            permissions,
            plugin_id: plugin_id.to_string(),
            event_tx,
            stderr_tail,
        })
    }

    /// 初始化握手：通知插件身份与 API 版本，返回插件声明的命令列表。
    pub fn init(&mut self, timeout: Duration) -> Result<Vec<String>, String> {
        let result = self.call_raw(
            "init",
            json!({ "apiVersion": 1, "pluginId": self.plugin_id }),
            timeout,
        )?;
        let commands = result
            .get("commands")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(commands)
    }

    /// 调用插件命令（带超时；期间处理插件发起的核心 API 请求与事件）。
    pub fn call(
        &mut self,
        command: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.call_raw("call", json!({ "command": command, "args": args }), timeout)
    }

    fn call_raw(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        // 出站写入也受同一超时预算约束：插件不读 stdin 导致写阻塞时，
        // send_timeout 会终止进程并返回错误，而不是无限卡死
        self.send_timeout(&Message::request(id, method, params), timeout)?;
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("插件命令超时({timeout:?}): {method}"));
            }
            let incoming = self.recv_incoming(remaining)?;
            match incoming {
                Incoming::Response { id: rid, result, error } if rid == id => {
                    if let Some(err) = error {
                        return Err(format!("插件错误 {}: {}", err.code, err.message));
                    }
                    return Ok(result.unwrap_or(Value::Null));
                }
                Incoming::Response { .. } => {
                    // 不匹配当前请求的响应（不应出现），忽略继续等待
                }
                Incoming::Request { id: rid, method: m, params: p } => {
                    self.handle_core_request(rid, &m, p)?;
                }
                Incoming::Event { event, data } => {
                    crate::core::log::info(&format!(
                        "[plugin:{}] event {event}: {data}",
                        self.plugin_id
                    ));
                    let _ = self.event_tx.send(PluginEvent {
                        plugin_id: self.plugin_id.clone(),
                        event,
                        data,
                    });
                }
                Incoming::Eof => {
                    return Err(format!("插件进程已退出: {}", self.plugin_id));
                }
            }
        }
    }

    /// 从通道取一条消息；锁在函数内释放，避免跨 `&mut self` 调用时持锁。
    fn recv_incoming(&self, timeout: Duration) -> Result<Incoming, String> {
        let rx = self.rx.lock().map_err(|e| e.to_string())?;
        match rx.recv_timeout(timeout) {
            Ok(m) => Ok(m),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                Err("插件命令超时".to_string())
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("插件通道已断开".to_string())
            }
        }
    }

    /// 插件 → 核心 API（v1：受限的 fs 读写 + 日志；按插件声明权限放行）。
    fn handle_core_request(&mut self, id: u64, method: &str, params: Value) -> Result<(), String> {
        // 权限校验：方法 → 所需权限
        let need = match method {
            "fs.readText" => Some("fs:read:vault"),
            "fs.writeText" => Some("fs:write:vault"),
            "fs.listDir" => Some("fs:read:vault"),
            "log" => Some("log"),
            "notify" => Some("notify"),
            "open" => Some("open"),
            "clipboard.read" => Some("clipboard"),
            "clipboard.write" => Some("clipboard"),
            "http.request" => Some("http"),
            "shell.exec" => Some("shell"),
            _ => None, // 未知方法统一在 execute_core_api 拒绝
        };
        if let Some(perm) = need {
            if !self.permissions.iter().any(|p| p == perm) {
                let err = format!("缺少权限 {perm}（请在 plugin.json 的 permissions 中声明）");
                let msg = Message::response_err(id, -32001, err);
                return self.send_timeout(&msg, Duration::from_secs(2));
            }
        }
        let result = self.execute_core_api(method, &params);
        let msg = match result {
            Ok(v) => Message::response_ok(id, v),
            Err(e) => Message::response_err(id, -32001, e),
        };
        self.send_timeout(&msg, Duration::from_secs(2))
    }

    /// 解析核心 API **读**路径：相对路径 → vault 下；绝对路径 → 仅当落在 Input（Inbox）
    /// 内才放行（工作区/插件可**只读**文件输入目录）。写操作（fs.writeText）不走此函数，
    /// 保持仅限 vault。空路径 / `..` / 越界与 resolve_safe 同规则拒绝。
    fn resolve_read(&self, path: &str) -> Result<PathBuf, String> {
        let pb = PathBuf::from(path);
        if pb.is_absolute() {
            let Some(inbox) = &self.inbox else {
                return Err("绝对路径仅支持文件输入（Input）目录".to_string());
            };
            let inb = std::fs::canonicalize(inbox).unwrap_or_else(|_| inbox.to_path_buf());
            let abs = std::fs::canonicalize(&pb).unwrap_or(pb);
            if abs == inb || abs.starts_with(&inb) {
                Ok(abs)
            } else {
                Err(format!("路径越出文件输入（Input）目录: {path}"))
            }
        } else {
            resolve_safe(&self.vault.to_string_lossy(), path)
        }
    }

    fn execute_core_api(&self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "fs.readText" => {
                let rel = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("缺少 path 参数")?;
                let p = self.resolve_read(rel)?;
                let text = std::fs::read_to_string(&p)
                    .map_err(|e| format!("读取失败: {e}"))?;
                Ok(json!(text))
            }
            "fs.writeText" => {
                let rel = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("缺少 path 参数")?;
                let content = params
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or("缺少 content 参数")?;
                let p = resolve_safe(&self.vault.to_string_lossy(), rel)?;
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
                }
                std::fs::write(&p, content).map_err(|e| format!("写入失败: {e}"))?;
                Ok(Value::Null)
            }
            // 目录枚举（searchProvider 等插件需要先知道 vault 里有什么才能搜索）。
            // dir 为空 = vault 根（resolve_safe 拒绝空路径，故特判）。
            "fs.listDir" => {
                let dir = params.get("dir").and_then(|v| v.as_str()).unwrap_or("");
                let p = if dir.is_empty() {
                    PathBuf::from(&self.vault)
                } else {
                    self.resolve_read(dir)?
                };
                if !p.is_dir() {
                    return Err(format!("目录不存在: {dir}"));
                }
                let Ok(read) = std::fs::read_dir(&p) else {
                    return Ok(json!([]));
                };
                let base = dir.trim_end_matches('/');
                let mut entries: Vec<Value> = Vec::new();
                for e in read.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    let size = if is_dir {
                        None
                    } else {
                        e.metadata().ok().map(|m| m.len())
                    };
                    // 修改时间（UNIX 毫秒整数）：搜索提供者等插件按"最近修改"排序结果
                    // （历史缺陷：深度优先遍历先到先得，新文件可能被旧文件挤出上限）
                    let mtime = e
                        .metadata()
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64);
                    let rel = if base.is_empty() {
                        name.clone()
                    } else {
                        format!("{base}/{name}")
                    };
                    entries.push(json!({
                        "name": name,
                        "path": rel,
                        "isDir": is_dir,
                        "size": size,
                        "mtime": mtime,
                    }));
                }
                entries.sort_by_key(|v| v["path"].as_str().unwrap_or("").to_string());
                Ok(json!(entries))
            }
            // ---- 插件日志（权限 log）----
            // 参数 {message, level?}（level: debug|info|warn|error，缺省 info）→ 宿主
            // 运行日志（logs/ 按天落盘 + dev 终端），来源前缀 [plugin:<id>]。
            "log" => {
                let msg = params.get("message").map(|v| v.to_string()).unwrap_or_default();
                let level = params
                    .get("level")
                    .and_then(|v| v.as_str())
                    .unwrap_or("info");
                let line = format!("[plugin:{}] {msg}", self.plugin_id);
                match level {
                    "debug" => crate::core::log::debug(&line),
                    "warn" => crate::core::log::warn(&line),
                    "error" => crate::core::log::error(&line),
                    _ => crate::core::log::info(&line),
                }
                Ok(Value::Null)
            }
            // ---- 通知（宿主 UI 横幅；权限 notify）----
            // 经 plugin-event `notification` 事件 → 宿主前端全局横幅显示。
            // 说明：不依赖系统通知插件（tauri-winrt-notification 曾致测试二进制
            // 加载崩溃 0xC0000139，见 HANDOVER §6.1）；应用最小化时横幅不可见。
            "notify" => {
                let title = params
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ToolBox")
                    .to_string();
                let body = params
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                match crate::plugins::native::host_app() {
                    Some(app) => {
                        use tauri::Emitter;
                        let _ = app.emit(
                            "plugin-event",
                            crate::plugins::events::PluginEvent {
                                plugin_id: self.plugin_id.clone(),
                                event: "notification".into(),
                                data: json!({ "title": title, "body": body }),
                            },
                        );
                        Ok(Value::Null)
                    }
                    None => Err("宿主未就绪（通知不可用）".to_string()),
                }
            }
            // ---- 默认应用打开路径（tauri-plugin-opener；权限 open）----
            "open" => {
                let rel = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("缺少 path 参数")?;
                let p = resolve_safe(&self.vault.to_string_lossy(), rel)?;
                match tauri_plugin_opener::open_path(p.to_string_lossy().as_ref(), None::<&str>) {
                    Ok(()) => Ok(Value::Null),
                    Err(e) => Err(format!("打开失败: {e}")),
                }
            }
            // ---- 剪贴板（tauri-plugin-clipboard-manager；权限 clipboard）----
            // 官方插件封装 arboard，行为一致：空剪贴板 read_text 返回同一 arboard 错误
            "clipboard.read" => {
                let Some(app) = crate::plugins::native::host_app() else {
                    return Err("宿主未就绪（剪贴板不可用）".to_string());
                };
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let text = app
                    .clipboard()
                    .read_text()
                    .map_err(|e| format!("读取剪贴板失败: {e}"))?;
                Ok(json!(text))
            }
            "clipboard.write" => {
                let text = params
                    .get("text")
                    .and_then(|v| v.as_str())
                    .ok_or("缺少 text 参数")?;
                let Some(app) = crate::plugins::native::host_app() else {
                    return Err("宿主未就绪（剪贴板不可用）".to_string());
                };
                use tauri_plugin_clipboard_manager::ClipboardExt;
                app.clipboard()
                    .write_text(text.to_string())
                    .map_err(|e| format!("写入剪贴板失败: {e}"))?;
                Ok(Value::Null)
            }
            // ---- 受控 HTTP 请求（reqwest blocking；权限 http）----
            // 参数 {url, method?, headers?, body?, timeoutSec?}；响应 {status, headers, text}
            // （文本按 UTF-8 lossy 解码；大小上限 4MB 防插件拉超大响应撑爆内存）
            "http.request" => {
                const HTTP_MAX_BYTES: u64 = 4 * 1024 * 1024;
                let url = params
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or("缺少 url 参数")?;
                let method = params
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("GET")
                    .to_uppercase();
                let timeout = params
                    .get("timeoutSec")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(10);
                let client = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(timeout))
                    .build()
                    .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;
                let mut req = client.request(
                    reqwest::Method::from_bytes(method.as_bytes())
                        .map_err(|e| format!("非法 method: {e}"))?,
                    url,
                );
                if let Some(h) = params.get("headers").and_then(|v| v.as_object()) {
                    for (k, v) in h {
                        if let Some(s) = v.as_str() {
                            req = req.header(k, s);
                        }
                    }
                }
                if let Some(b) = params.get("body").and_then(|v| v.as_str()) {
                    req = req.body(b.to_string());
                }
                let resp = req.send().map_err(|e| format!("请求失败: {e}"))?;
                let status = resp.status().as_u16();
                let headers: serde_json::Map<String, Value> = resp
                    .headers()
                    .iter()
                    .map(|(k, v)| {
                        (
                            k.as_str().to_string(),
                            Value::String(v.to_str().unwrap_or("").to_string()),
                        )
                    })
                    .collect();
                let bytes = resp
                    .bytes()
                    .map_err(|e| format!("读取响应失败: {e}"))?;
                if bytes.len() as u64 > HTTP_MAX_BYTES {
                    return Err(format!(
                        "响应过大（{} bytes，上限 4MB）",
                        bytes.len()
                    ));
                }
                Ok(json!({
                    "status": status,
                    "headers": headers,
                    "text": String::from_utf8_lossy(&bytes).into_owned(),
                }))
            }
            // ---- 执行命令（tauri-plugin-shell；权限 shell）----
            // 参数 {cmd, args?, timeoutSec?}；返回 {code, stdout, stderr}
            // 强能力：仅声明 shell 权限的插件可用；cwd = 工作区（实际行为）
            // 说明：与 std::process 直接 spawn 的差异——输出为"全量捕获后截 40 行尾"
            //   （超大输出时内存占用高于旧"写临时文件再截尾"），命令名/超时/终止语义不变。
            "shell.exec" => {
                let cmd = params
                    .get("cmd")
                    .and_then(|v| v.as_str())
                    .ok_or("缺少 cmd 参数")?;
                let args: Vec<String> = params
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let timeout = params
                    .get("timeoutSec")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(10);
                let Some(app) = crate::plugins::native::host_app() else {
                    return Err("宿主未就绪（无法执行命令）".to_string());
                };
                use tauri_plugin_shell::process::CommandEvent;
                use tauri_plugin_shell::ShellExt;
                let (mut rx, child) = app
                    .shell()
                    .command(cmd)
                    .args(&args)
                    .current_dir(&self.vault)
                    .spawn()
                    .map_err(|e| format!("启动命令失败（{cmd}）: {e}"))?;
                let deadline = std::time::Instant::now()
                    + std::time::Duration::from_secs(timeout);
                let mut stdout = String::new();
                let mut stderr = String::new();
                let mut code: Option<i32> = None;
                let mut exec_err: Option<String> = None;
                loop {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        exec_err = Some(format!("命令超过 {timeout} 秒未完成，已终止"));
                        break;
                    }
                    match rx.try_recv() {
                        Ok(CommandEvent::Stdout(b)) => {
                            stdout.push_str(&String::from_utf8_lossy(&b));
                        }
                        Ok(CommandEvent::Stderr(b)) => {
                            stderr.push_str(&String::from_utf8_lossy(&b));
                        }
                        Ok(CommandEvent::Terminated(p)) => {
                            code = p.code;
                            break;
                        }
                        Ok(CommandEvent::Error(e)) => {
                            exec_err = Some(format!("命令执行失败: {e}"));
                            break;
                        }
                        Ok(_) => { /* CommandEvent 是非穷举枚举，忽略未知变体 */ }
                        Err(_) => {
                            if rx.is_closed() {
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                    }
                }
                let tail = |s: &str| -> String {
                    let lines: Vec<&str> = s.lines().collect();
                    let start = lines.len().saturating_sub(40);
                    lines[start..].join("\n")
                };
                let out_tail = tail(&stdout);
                let err_tail = tail(&stderr);
                if let Some(e) = exec_err {
                    Err(format!("{e}\nstderr：\n{err_tail}"))
                } else {
                    Ok(json!({ "code": code.unwrap_or(-1), "stdout": out_tail, "stderr": err_tail }))
                }
            }
            other => Err(format!("插件调用了未开放的核心 API: {other}")),
        }
    }

    /// 进程是否已退出。
    pub fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    /// 最近捕获的插件 stderr 文本（init 握手失败时用于定位缺依赖/Python traceback）。
    pub fn stderr_tail(&self) -> String {
        let Ok(t) = self.stderr_tail.lock() else {
            return String::new();
        };
        t.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// 写一条消息到插件 stdin，带超时兜底：
    /// 插件不消费 stdin（挂死）时，管道缓冲写满会让 `write_all` 无限阻塞，
    /// 这里通过写线程 + ack 通道在超时后**终止进程**解除阻塞并报错。
    /// `pub(crate)`：供测试直接验证挂死回收路径。
    pub(crate) fn send_timeout(&mut self, msg: &Message, timeout: Duration) -> Result<(), String> {
        let line = rpc::encode(msg)?;
        let (ack_tx, ack_rx) = channel();
        self.write_tx
            .send(WriteReq::Send {
                bytes: line.into_bytes(),
                ack: ack_tx,
            })
            .map_err(|_| "插件写通道已关闭".to_string())?;
        match ack_rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // 写线程还阻塞在 write_all 上；杀掉进程树让管道对端关闭，
                // 写线程随即收到 BrokenPipe 退出，不会残留阻塞线程
                kill_process_tree(&mut self.child);
                Err(format!(
                    "写入插件 stdin 超时({timeout:?})，插件已挂死，进程已终止"
                ))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                Err("插件写线程已退出".to_string())
            }
        }
    }

    /// 关闭：发 shutdown 通知（带短超时）并回收进程。
    pub fn shutdown(mut self) {
        self.shutdown_inner();
    }

    fn shutdown_inner(&mut self) {
        let _ = self.send_timeout(
            &Message::notification("shutdown", None),
            Duration::from_millis(500),
        );
        kill_process_tree(&mut self.child);
        let _ = self.child.wait();
    }
}

/// 终止子进程及其整棵进程树。
///
/// **为什么需要**：Windows 上 `Child::kill` 只杀直接子进程——插件
/// （Python/脚本）再派生的孙进程会成孤儿继续运行（占用文件/端口/CPU）。
/// `taskkill /T /F` 按 PID 递归终止整棵树；非 Windows 平台无进程树 API，
/// 退回 `kill`（Unix 子进程通常同会话，普通场景够用）。
fn kill_process_tree(child: &mut std::process::Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id();
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        // taskkill 可能已结束进程；再 kill 一次兜底（幂等，无害）
        let _ = child.kill();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }
}

/// 常驻写线程：独占 ChildStdin 执行阻塞写，主线程只通过通道等 ack。
/// 线程退出时 stdin drop → 管道关闭。
fn spawn_write_thread(mut stdin: ChildStdin) -> Sender<WriteReq> {
    let (tx, rx) = channel();
    thread::spawn(move || {
        while let Ok(req) = rx.recv() {
            match req {
                WriteReq::Send { bytes, ack } => {
                    let r = stdin
                        .write_all(&bytes)
                        .map_err(|e| format!("写入插件 stdin 失败: {e}"));
                    let _ = ack.send(r);
                }
                WriteReq::Shutdown => break,
            }
        }
    });
    tx
}

/// Drop 兜底：任何路径下（init 失败/调用方未显式 shutdown）回收子进程，
/// 防止孤儿 Python 进程、写线程与读线程泄漏。
impl Drop for ProcessPlugin {
    fn drop(&mut self) {
        // 关闭写通道 → 写线程 recv 返回 Err 退出 → stdin drop 关闭管道
        let _ = self.write_tx.send(WriteReq::Shutdown);
        kill_process_tree(&mut self.child);
        let _ = self.child.wait();
    }
}

/// 单行最大字节数：异常/恶意插件打印无换行大块数据时防止内存被撑爆。
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

/// stderr 保留的最大行数（缺依赖报错足够，防止无限增长）。
const STDERR_TAIL_MAX: usize = 40;

/// stderr 读线程：把插件 stderr 当作日志转发（core::log），同时保留最近
/// `STDERR_TAIL_MAX` 行，供 init 失败时回显（Python traceback / 缺依赖原因）。
/// 必须持续读：Windows 管道缓冲写满会阻塞插件进程（stderr 不消费 = 挂死）。
/// 按字节读 + lossy 解码：插件输出非法 UTF-8（如 GBK）不中断读取。
fn read_stderr_loop(stderr: ChildStderr, tail: Arc<Mutex<VecDeque<String>>>) {
    let mut reader = BufReader::new(stderr);
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break, // EOF / 管道关闭
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let trimmed = line.trim_end().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                crate::core::log::info(&format!("[plugin:stderr] {trimmed}"));
                if let Ok(mut t) = tail.lock() {
                    t.push_back(trimmed);
                    while t.len() > STDERR_TAIL_MAX {
                        t.pop_front();
                    }
                }
            }
        }
    }
}

/// 丢弃超长行的剩余字节直到换行（固定小缓冲循环读，避免再引入无上限读）。
fn drain_overlong_line(reader: &mut impl Read) {
    let mut sink = [0u8; 8192];
    loop {
        match reader.read(&mut sink) {
            Ok(0) => break, // EOF：无更多数据
            Ok(n) => {
                if sink[..n].contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn read_loop(stdout: ChildStdout, tx: Sender<Incoming>) {
    let mut reader = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    // 错误事件限流：垃圾输出插件会每行都触发 __parse_error__/__line_too_long__，
    // 不加限流会把前端事件总线刷爆。这里每 1 秒最多发一条（初始值提前，首条即发）。
    let mut last_error_event = Instant::now() - Duration::from_secs(2);
    loop {
        buf.clear();
        // 按字节读 + lossy 解码：插件输出非法 UTF-8（如 GBK）时不应误判进程退出。
        // 用 take 在读取阶段就封顶（而非读完整行后才发现超长），防止失控/恶意
        // 插件打印无换行大块数据把宿主内存撑爆。
        let mut limited = (&mut reader).take((MAX_LINE_BYTES + 1) as u64);
        let read = limited.read_until(b'\n', &mut buf);
        // 命中 take 上限且末尾不是换行 → 行被截断，判定为超长行
        let overlong = buf.len() == MAX_LINE_BYTES + 1 && buf.last() != Some(&b'\n');
        match read {
            Ok(0) => {
                let _ = tx.send(Incoming::Eof);
                break;
            }
            Ok(_) if overlong => {
                // 超长行：丢弃该行（含剩余字节）并记事件，不中断读循环
                if last_error_event.elapsed() >= Duration::from_secs(1) {
                    last_error_event = Instant::now();
                    let _ = tx.send(Incoming::Event {
                        event: "__line_too_long__".to_string(),
                        data: json!({ "bytes": MAX_LINE_BYTES + 1 }),
                    });
                }
                drain_overlong_line(&mut reader);
                continue;
            }
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match rpc::decode(trimmed) {
                    Ok(Message::Response { id, result, error }) => {
                        let _ = tx.send(Incoming::Response { id, result, error });
                    }
                    Ok(Message::Request { id, method, params }) => {
                        let _ = tx.send(Incoming::Request {
                            id,
                            method,
                            params: params.unwrap_or(Value::Null),
                        });
                    }
                    Ok(Message::Notification { method, params }) => {
                        let _ = tx.send(Incoming::Event {
                            event: method,
                            data: params.unwrap_or(Value::Null),
                        });
                    }
                    Err(e) => {
                        if last_error_event.elapsed() >= Duration::from_secs(1) {
                            last_error_event = Instant::now();
                            let _ = tx.send(Incoming::Event {
                                event: "__parse_error__".to_string(),
                                data: json!({ "line": trimmed, "error": e }),
                            });
                        }
                    }
                }
            }
            Err(_) => {
                let _ = tx.send(Incoming::Eof);
                break;
            }
        }
    }
}
