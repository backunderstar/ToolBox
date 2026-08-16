//! 进程插件桥：子进程 + JSON-RPC over stdio。
//!
//! - 独立读线程把插件 stdout 的行解析为 `Incoming` 消息送入 mpsc 通道
//! - `call` 支持超时；期间插件可反向调用核心 API（fs.readText / fs.writeText / log）
//! - 崩溃/退出通过 `Eof` 信号检测，由上层管理器决定是否重启

use crate::core::path::resolve_safe;
use crate::plugins::events::PluginEvent;
use crate::rpc::{self, Message, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
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
    /// 插件声明的权限（execute_core_api 据此放行核心 API）
    permissions: Vec<String>,
    pub plugin_id: String,
    /// 事件桥：插件 Notification → 前端（纯 mpsc，不接触 tauri 类型）
    event_tx: Sender<PluginEvent>,
}

impl ProcessPlugin {
    /// 启动插件进程（cwd = 插件目录，便于脚本用相对路径）。
    pub fn spawn(
        plugin_id: &str,
        program: &str,
        args: &[String],
        plugin_dir: &Path,
        vault: &Path,
        permissions: Vec<String>,
        event_tx: Sender<PluginEvent>,
    ) -> Result<Self, String> {
        let mut child = Command::new(program)
            .args(args)
            .current_dir(plugin_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // 插件 stderr 直接透传到终端（作为日志）
            .spawn()
            .map_err(|e| format!("启动插件进程失败（{program}）: {e}"))?;
        let stdin = child.stdin.take().ok_or("无法获取插件 stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取插件 stdout")?;
        let (tx, rx) = channel();
        thread::spawn(move || read_loop(stdout, tx));
        let write_tx = spawn_write_thread(stdin);
        Ok(Self {
            child,
            write_tx,
            rx: Mutex::new(rx),
            next_id: 0,
            vault: vault.to_path_buf(),
            permissions,
            plugin_id: plugin_id.to_string(),
            event_tx,
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
                    eprintln!("[plugin:{}] event {event}: {data}", self.plugin_id);
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

    fn execute_core_api(&self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "fs.readText" => {
                let rel = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("缺少 path 参数")?;
                let p = resolve_safe(&self.vault.to_string_lossy(), rel)?;
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
                    resolve_safe(&self.vault.to_string_lossy(), dir)?
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
            "log" => {
                let msg = params.get("message").map(|v| v.to_string()).unwrap_or_default();
                eprintln!("[plugin:{}] {msg}", self.plugin_id);
                Ok(Value::Null)
            }
            other => Err(format!("插件调用了未开放的核心 API: {other}")),
        }
    }

    /// 进程是否已退出。
    pub fn has_exited(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(_)) => true,
            _ => false,
        }
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

fn read_loop(stdout: ChildStdout, tx: Sender<Incoming>) {
    let mut reader = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        // 按字节读 + lossy 解码：插件输出非法 UTF-8（如 GBK）时不应误判进程退出
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => {
                let _ = tx.send(Incoming::Eof);
                break;
            }
            Ok(_) => {
                if buf.len() > MAX_LINE_BYTES {
                    // 超长行：丢弃该行并记事件（不中断读循环）
                    let _ = tx.send(Incoming::Event {
                        event: "__line_too_long__".to_string(),
                        data: json!({ "bytes": buf.len() }),
                    });
                    continue;
                }
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
                        let _ = tx.send(Incoming::Event {
                            event: "__parse_error__".to_string(),
                            data: json!({ "line": trimmed, "error": e }),
                        });
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
