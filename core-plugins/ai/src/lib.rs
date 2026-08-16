//! AI 核心插件（cdylib，id: core-ai）。
//!
//! 配置存 config_dir/ai.json（baseUrl/model，不含 Key）；API Key 存系统
//! 凭据管理器（keyring）。流式对话：SSE 增量经 host.emit_event 推
//! `ai-chunk` 事件（前端监听 plugin-event 过滤）。

mod chat;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::OnceLock;
use tb_sdk::{emit, tb_plugin, TbHostApi};

/// 凭据管理器条目
const KEYRING_SERVICE: &str = "com.toolbox.desktop";
const KEYRING_USER: &str = "ai-api-key";

/// 跨线程安全包装（std::thread::spawn / rt().spawn 要求捕获的变量实现 Send）：
/// - 宿主回调表 `TbHostApi` 含函数指针 + `*mut c_void`，本身不是 Send；
/// - 上下文指针 `*mut c_void` 同理。
/// 这里只把它们**原样透传**到流式任务（不解引用、不释放、不改写），
/// 实际使用方（emit 回调 → 宿主 mpsc Sender）是线程安全的，故 unsafe impl Send
/// 是安全的。这是 FFI 边界常见的"指针搬运"模式，务必保持"只透传"约定。
///
/// 注意：解包必须经 `get()` 方法（借用 self 返回 Copy 值）——若在闭包里直接写
/// `host.0`，Rust 的分离捕获（RFC 2229）会捕获解包后的 `TbHostApi`（非 Send）
/// 而非包装本身，Send 检查照样失败；而按值的方法（self 按值）在 FnMut 闭包里
/// 又会被禁止（不能 move 捕获变量），所以这里用 &self 借用 + Copy 返回值。
#[derive(Clone, Copy)]
struct SendHost(TbHostApi);
// Send：包装值可 move 跨线程；Sync：&SendHost 可共享（闭包经 &self 借用 get() 时需要）
unsafe impl Send for SendHost {}
unsafe impl Sync for SendHost {}
impl SendHost {
    fn get(&self) -> TbHostApi {
        self.0
    }
}
#[derive(Clone, Copy)]
struct SendCtx(*mut c_void);
unsafe impl Send for SendCtx {}
unsafe impl Sync for SendCtx {}
impl SendCtx {
    fn get(&self) -> *mut c_void {
        self.0
    }
}

/// 非流式对话复用单一 blocking 客户端
static BLOCKING_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    pub base_url: String,
    pub model: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-chat".into(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

pub struct AiState {
    /// 应用配置目录（%APPDATA%/com.toolbox.desktop，宿主传入）
    config_dir: String,
    /// 插件自建 tokio 运行时（流式任务执行池）。
    ///
    /// **为什么放实例而不是 static（重要，S4）**：static 的 Runtime 生命周期
    /// 与进程相同，其 worker 线程会一直运行 DLL 里的代码；宿主禁用/重载插件
    /// 即 FreeLibrary 卸载 DLL，残留线程执行已卸载代码 → 宿主崩溃。把 runtime
    /// 放进 AiState 后，tb_destroy → drop AiState → Runtime drop 自动 shutdown
    /// 并 join 全部 worker 线程 → 卸载 DLL 时无残留线程，安全。
    rt: tokio::runtime::Runtime,
}

/// 构建插件自建运行时（多线程，2 worker；网络 + 时间驱动均启用）。
fn build_rt() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .map_err(|e| format!("构建 tokio runtime 失败: {e}"))
}

fn state_from_cfg(cfg: &Value) -> Result<AiState, String> {
    let config_dir = cfg
        .get("config_dir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if config_dir.is_empty() {
        return Err("缺少 config_dir 配置".to_string());
    }
    Ok(AiState {
        config_dir,
        rt: build_rt()?,
    })
}

/* ---------------- 配置与凭据 ---------------- */

fn config_path(state: &AiState) -> PathBuf {
    PathBuf::from(&state.config_dir).join("ai.json")
}

fn load_config(state: &AiState) -> AiConfig {
    let p = config_path(state);
    if !p.exists() {
        return AiConfig::default();
    }
    match std::fs::read_to_string(&p).and_then(|raw| {
        serde_json::from_str(&raw).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, e)
        })
    }) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ai] 配置读取失败（{p:?}），已回退默认值: {e}");
            AiConfig::default()
        }
    }
}

fn save_config(state: &AiState, cfg: &AiConfig) -> Result<(), String> {
    let p = config_path(state);
    std::fs::create_dir_all(p.parent().unwrap_or(PathBuf::new().as_path()))
        .map_err(|e| format!("创建配置目录失败: {e}"))?;
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| format!("保存配置失败: {e}"))
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("访问系统凭据管理器失败: {e}"))
}

fn load_key() -> Option<String> {
    let entry = keyring_entry().ok()?;
    entry.get_password().ok().filter(|k| !k.trim().is_empty())
}

fn save_key(key: &str) -> Result<(), String> {
    let entry = keyring_entry()?;
    entry
        .set_password(key.trim())
        .map_err(|e| format!("保存 API Key 到凭据管理器失败: {e}"))
}

fn clear_key() -> Result<(), String> {
    let entry = keyring_entry()?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("清除 API Key 失败: {e}")),
    }
}

/// 一次性迁移：旧版 ai.json 明文 apiKey → 凭据管理器，随后清除明文。
fn migrate_legacy_key(state: &AiState) {
    if load_key().is_some() {
        return;
    }
    let p = config_path(state);
    if let Ok(raw) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let Some(k) = v.get("apiKey").and_then(|k| k.as_str()) {
                if !k.trim().is_empty() && save_key(k).is_ok() {
                    eprintln!("[ai] 已把明文 API Key 迁移到系统凭据管理器");
                    if let Some(obj) = v.as_object() {
                        let mut clean = obj.clone();
                        clean.remove("apiKey");
                        if let Ok(pretty) = serde_json::to_string_pretty(&clean) {
                            let _ = std::fs::write(&p, pretty);
                        }
                    }
                }
            }
        }
    }
}

/* ---------------- 命令 ---------------- */

fn config_get(state: &AiState) -> Result<Value, String> {
    let cfg = load_config(state);
    migrate_legacy_key(state);
    serde_json::to_value(json!({
        "baseUrl": cfg.base_url,
        "model": cfg.model,
        "hasKey": load_key().is_some(),
    }))
    .map_err(|e| e.to_string())
}

fn config_set(state: &AiState, params: &Value) -> Result<Value, String> {
    let cfg: AiConfig = serde_json::from_value(params.get("config").cloned().unwrap_or(Value::Null))
        .map_err(|e| format!("配置非法: {e}"))?;
    save_config(state, &cfg)?;
    Ok(Value::Null)
}

fn config_set_key(params: &Value) -> Result<Value, String> {
    let key = params
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("缺少 key")?;
    if key.trim().is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    save_key(key)?;
    Ok(Value::Null)
}

fn config_clear_key() -> Result<Value, String> {
    clear_key()?;
    Ok(Value::Null)
}

fn chat(state: &AiState, params: &Value) -> Result<Value, String> {
    let messages: Vec<ChatMessage> =
        serde_json::from_value(params.get("messages").cloned().unwrap_or(Value::Null))
            .map_err(|e| format!("messages 非法: {e}"))?;
    let cfg = load_config(state);
    let api_key =
        load_key().ok_or_else(|| "未配置 API Key —— 请在设置页的「AI」区块填写".to_string())?;
    let base = cfg.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 API 地址".to_string());
    }
    let url = format!("{base}/chat/completions");
    let body = json!({
        "model": cfg.model,
        "messages": messages,
        "stream": false
    });

    let client = BLOCKING_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    });

    let resp = client
        .post(&url)
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .map_err(|e| format!("请求失败（检查网络或 API 地址）: {e}"))?;

    let status = resp.status();
    let text = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        let detail = chat::extract_error(&text);
        return Err(format!("API 返回 {status}: {detail}"));
    }

    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {e}"))?;
    let content = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .ok_or("响应缺少 choices[0].message.content")?;
    Ok(Value::String(content.to_string()))
}

/// 流式请求主体（async）：发请求 + 消费 SSE + 逐段推 `ai-chunk`。
/// 提取为独立 async 函数：future 只捕获函数参数（SendHost/SendCtx 为 Send 包装，
/// url/api_key/body 为 owned），满足 `rt().spawn` 的 `Future: Send + 'static` 约束。
async fn chat_stream_inner(
    host: SendHost,
    ctx: SendCtx,
    url: String,
    api_key: String,
    body: Value,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("创建客户端失败: {e}"))?;
    let resp = client
        .post(&url)
        .bearer_auth(api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败（检查网络或 API 地址）: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {e}"))?;
        let detail = chat::extract_error(&text);
        return Err(format!("API 返回 {status}: {detail}"));
    }
    // 逐块读取 SSE 流，增量推 ai-chunk（经事件桥转发 plugin-event）。
    // 闭包内必须用 get() 解包（见 SendHost/SendCtx 注释：分离捕获 + FnMut 限制）。
    let stream = resp.bytes_stream();
    chat::consume_sse(stream, |text| {
        emit(
            host.get(),
            ctx.get(),
            "ai-chunk",
            json!({ "text": text }),
        );
    })
    .await?;
    Ok(Value::Null)
}

/// 流式对话：SSE 增量经 host.emit_event 推 `ai-chunk`（前端打字机）。
///
/// **为什么这里必须派发独立线程（重要）**：宿主 `plugin_call` 是 async 命令，
/// 运行在 tauri 的 tokio worker 线程上。若在本线程直接 `rt().block_on(...)`
/// 嵌套另一个 tokio Runtime，tokio 会检测到"运行时内再 block_on"并直接 panic
/// （被 tb_plugin! 宏 catch_unwind 吞成"插件 panic（已隔离）"，流式对话静默全坏）。
/// 这里改用插件自建的多线程 runtime `rt().spawn` 派发：future 在 runtime 的
/// worker 线程上执行，`emit` 走宿主事件桥（mpsc channel，线程安全），合法且不阻塞调用方。
///
/// **契约变化**：本函数现在立即返回（仅表示"流式任务已派发"），流式增量经
/// `ai-chunk` 事件到达，流结束/失败经 `ai-done` 事件通知（`{ok, error?}`）。
/// 前端 `runChatStream` 相应改为等待 `ai-done` 而不是等待 call resolve。
fn chat_stream(state: &AiState, host: TbHostApi, ctx: *mut c_void, params: &Value) -> Result<Value, String> {
    // 同步部分：先解析参数/配置/凭据（失败直接返回给 call 调用方，无需起线程）
    let messages: Vec<ChatMessage> =
        serde_json::from_value(params.get("messages").cloned().unwrap_or(Value::Null))
            .map_err(|e| format!("messages 非法: {e}"))?;
    let cfg = load_config(state);
    let api_key =
        load_key().ok_or_else(|| "未配置 API Key —— 请在设置页的「AI」区块填写".to_string())?;
    let base = cfg.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 API 地址".to_string());
    }
    let url = format!("{base}/chat/completions");
    let body = json!({
        "model": cfg.model,
        "messages": messages,
        "stream": true
    });

    // 裸指针/TbHostApi 不是 Send，用 SendHost/SendCtx 包装后再跨线程传递
    // （包装语义见结构体注释：只透传不解引用，故 unsafe impl Send 安全）。
    let host_send = SendHost(host);
    let ctx_send = SendCtx(ctx);
    // fire-and-forget：不 await JoinHandle；任务完成/失败统一发 ai-done 通知前端。
    // 注意：task 内部失败都会经 Err 走 ai-done，不会静默悬挂。
    // 运行时来自 state（实例持有，卸载时 drop → shutdown → 线程退出，见 AiState 注释）。
    state.rt.spawn(async move {
        let result = chat_stream_inner(host_send, ctx_send, url, api_key, body).await;
        match result {
            Ok(_) => emit(
                host_send.get(),
                ctx_send.get(),
                "ai-done",
                json!({ "ok": true }),
            ),
            Err(e) => emit(
                host_send.get(),
                ctx_send.get(),
                "ai-done",
                json!({ "ok": false, "error": e }),
            ),
        }
    });
    Ok(Value::Null)
}

fn test(state: &AiState) -> Result<Value, String> {
    if load_key().is_none() {
        return Err("未配置 API Key".to_string());
    }
    let params = json!({
        "messages": [{ "role": "user", "content": "回复「连接成功」四个字" }]
    });
    chat(state, &params)
}

/// 命令分发。ai.chat 非流式 = 宿主线程上同步阻塞调用（blocking reqwest，120s 超时）；
/// ai.chatStream 流式 = 派发独立线程执行（见 chat_stream 注释，防 tokio block_on 嵌套 panic）。
fn call(
    state: &mut AiState,
    host: TbHostApi,
    ctx: *mut c_void,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    match method {
        "ai.configGet" => config_get(state),
        "ai.configSet" => config_set(state, &params),
        "ai.configSetKey" => config_set_key(&params),
        "ai.configClearKey" => config_clear_key(),
        "ai.chat" => chat(state, &params),
        "ai.chatStream" => chat_stream(state, host, ctx, &params),
        "ai.test" => test(state),
        _ => Err(format!("未知命令: {method}")),
    }
}

tb_plugin!(AiState, state_from_cfg, call);
