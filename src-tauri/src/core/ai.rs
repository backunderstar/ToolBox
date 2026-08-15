//! M6 AI 集成：提供商配置（OpenAI 兼容）与对话调用。
//!
//! - 配置存于系统配置目录（%APPDATA%/com.toolbox.desktop/ai.json），与 vault 分离
//! - ai_chat：POST {base_url}/chat/completions（OpenAI 兼容，非流式 v1）
//! - ai_test：最小请求验证配置连通性
//! - 无 key / 网络错误 / 非 2xx 都转为可读错误信息

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

/// 复用单一 HTTP 客户端（连接池 + TLS 会话）
static HTTP_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".into(),
            api_key: String::new(),
            model: "deepseek-chat".into(),
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("ai.json"))
}

fn load_config(app: &tauri::AppHandle) -> AiConfig {
    let Ok(p) = config_path(app) else {
        return AiConfig::default();
    };
    if !p.exists() {
        return AiConfig::default();
    }
    match std::fs::read_to_string(&p).and_then(|raw| {
        serde_json::from_str(&raw).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ai] 配置读取失败（{p:?}），已回退默认值: {e}");
            AiConfig::default()
        }
    }
}

#[tauri::command]
pub fn ai_config_get(app: tauri::AppHandle) -> AiConfig {
    load_config(&app)
}

#[tauri::command]
pub fn ai_config_set(app: tauri::AppHandle, config: AiConfig) -> Result<(), String> {
    let p = config_path(&app)?;
    let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| format!("保存配置失败: {e}"))
}

/// 清空 key 后再保存（用于"清除 API Key"）。
#[tauri::command]
pub fn ai_config_clear_key(app: tauri::AppHandle) -> Result<(), String> {
    let mut c = load_config(&app);
    c.api_key.clear();
    ai_config_set(app, c)
}

/// 对话：OpenAI 兼容 chat/completions（非流式）。
/// async 命令：阻塞的 reqwest 调用在异步运行时线程执行，不冻结主线程/UI。
#[tauri::command]
pub async fn ai_chat(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let cfg = load_config(&app);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key —— 请在设置页的「AI」区块填写".to_string());
    }
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

    let client = HTTP_CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .expect("创建 HTTP 客户端失败")
    });

    let resp = client
        .post(&url)
        .bearer_auth(cfg.api_key.trim())
        .json(&body)
        .send()
        .map_err(|e| format!("请求失败（检查网络或 API 地址）: {e}"))?;

    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        let detail = extract_error(&text);
        return Err(format!("API 返回 {status}: {detail}"));
    }

    let v: Value = serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {e}"))?;
    let content = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .ok_or("响应缺少 choices[0].message.content")?;
    Ok(content.to_string())
}

/// 连通性测试：发一个最小对话请求。
#[tauri::command]
pub async fn ai_test(app: tauri::AppHandle) -> Result<String, String> {
    let cfg = load_config(&app);
    if cfg.api_key.trim().is_empty() {
        return Err("未配置 API Key".to_string());
    }
    let reply = ai_chat(
        app,
        vec![ChatMessage {
            role: "user".into(),
            content: "回复「连接成功」四个字".into(),
        }],
    )
    .await?;
    Ok(reply)
}

fn extract_error(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.pointer("/message"))
                .and_then(|m| m.as_str().map(String::from))
        })
        .unwrap_or_else(|| body.chars().take(300).collect())
}
