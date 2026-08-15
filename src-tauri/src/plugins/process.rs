//! 进程插件桥：子进程 + JSON-RPC over stdio。
//!
//! - 独立读线程把插件 stdout 的行解析为 `Incoming` 消息送入 mpsc 通道
//! - `call` 支持超时；期间插件可反向调用核心 API（fs.readText / fs.writeText / log）
//! - 崩溃/退出通过 `Eof` 信号检测，由上层管理器决定是否重启

use crate::core::path::resolve_safe;
use crate::rpc::{self, Message, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

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

pub struct ProcessPlugin {
    child: Child,
    stdin: ChildStdin,
    /// mpsc Receiver 非 Sync，包一层 Mutex 以满足 tauri 状态要求
    rx: Mutex<Receiver<Incoming>>,
    next_id: u64,
    vault: PathBuf,
    /// 插件声明的权限（execute_core_api 据此放行核心 API）
    permissions: Vec<String>,
    pub plugin_id: String,
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
        Ok(Self {
            child,
            stdin,
            rx: Mutex::new(rx),
            next_id: 0,
            vault: vault.to_path_buf(),
            permissions,
            plugin_id: plugin_id.to_string(),
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
        self.send(&Message::request(id, method, params))?;
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
            "log" => Some("log"),
            _ => None, // 未知方法统一在 execute_core_api 拒绝
        };
        if let Some(perm) = need {
            if !self.permissions.iter().any(|p| p == perm) {
                let err = format!("缺少权限 {perm}（请在 plugin.json 的 permissions 中声明）");
                let msg = Message::response_err(id, -32001, err);
                return self.send(&msg);
            }
        }
        let result = self.execute_core_api(method, &params);
        let msg = match result {
            Ok(v) => Message::response_ok(id, v),
            Err(e) => Message::response_err(id, -32001, e),
        };
        self.send(&msg)
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

    /// 停止：发 shutdown 通知并回收进程。
    pub fn shutdown(mut self) {
        self.shutdown_inner();
    }

    fn shutdown_inner(&mut self) {
        let _ = self.send(&Message::notification("shutdown", None));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn send(&mut self, msg: &Message) -> Result<(), String> {
        let line = rpc::encode(msg)?;
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("写入插件 stdin 失败: {e}"))
    }
}

/// Drop 兜底：任何路径下（init 失败/调用方未显式 shutdown）回收子进程，
/// 防止孤儿 Python 进程与读线程泄漏。
impl Drop for ProcessPlugin {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

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
