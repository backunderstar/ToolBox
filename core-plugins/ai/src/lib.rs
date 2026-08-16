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

/// 流式 tokio 运行时（插件内自建，与宿主解耦）
static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
fn rt() -> &'static tokio::runtime::Runtime {
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .build()
            .expect("构建 tokio runtime 失败")
    })
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
    Ok(AiState { config_dir })
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

/// 流式对话：SSE 增量经 host.emit_event 推 `ai-chunk`（前端打字机）。
fn chat_stream(state: &AiState, host: TbHostApi, ctx: *mut c_void, params: &Value) -> Result<Value, String> {
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

    rt().block_on(async move {
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
        // 逐块读取 SSE 流，增量推 ai-chunk（经事件桥转发 plugin-event）
        let stream = resp.bytes_stream();
        chat::consume_sse(stream, |text| {
            emit(host, ctx, "ai-chunk", json!({ "text": text }));
        })
        .await?;
        Ok(Value::Null)
    })
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

/// 命令分发。流式/对话是宿主线程上的同步调用（blocking reqwest / tokio block_on）。
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
