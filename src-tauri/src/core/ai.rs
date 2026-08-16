//! M6 AI 集成：提供商配置（OpenAI 兼容）与对话调用。
//!
//! - 配置存于系统配置目录（%APPDATA%/com.toolbox.desktop/ai.json），与 vault 分离
//! - **API Key 不落盘明文**：存系统凭据管理器（Windows Credential Manager / macOS
//!   Keychain / Linux Secret Service，经 keyring crate）；ai.json 只存 baseUrl/model
//! - 旧版 ai.json 里的明文 apiKey 在首次读取时自动迁移进凭据管理器并清除
//! - ai_chat：POST {base_url}/chat/completions（OpenAI 兼容，非流式 v1）
//! - ai_chat_stream：`"stream": true` + SSE 逐段解析，把增量经 `ai-chunk` 事件
//!   推给前端（打字机效果）；请求完成即命令 resolve
//! - 无 key / 网络错误 / 非 2xx 都转为可读错误信息

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{Emitter, Manager};

/// 流式增量载荷（`ai-chunk` 事件）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiChunk {
    pub text: String,
}

/// 复用单一 HTTP 客户端（连接池 + TLS 会话）
static HTTP_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

/// 凭据管理器条目：service = 应用标识，user = 条目名
const KEYRING_SERVICE: &str = "com.toolbox.desktop";
const KEYRING_USER: &str = "ai-api-key";

/// 持久化的非敏感配置（ai.json）。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AiConfig {
    pub base_url: String,
    pub model: String,
}

/// 返回给前端的配置视图（不含 Key 明文，只有是否已设置）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigView {
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
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

fn save_config(app: &tauri::AppHandle, cfg: &AiConfig) -> Result<(), String> {
    let p = config_path(app)?;
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, raw).map_err(|e| format!("保存配置失败: {e}"))
}

/* ---------------- 凭据管理器（API Key） ---------------- */

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("访问系统凭据管理器失败: {e}"))
}

/// 读取 API Key（无条目 / 读取失败 → None）。
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
        // 条目不存在视为已清除
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("清除 API Key 失败: {e}")),
    }
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
pub fn ai_config_get(app: tauri::AppHandle) -> AiConfigView {
    let cfg = load_config(&app);
    // 一次性迁移：旧版 ai.json 里的明文 apiKey → 凭据管理器，随后清除明文
    if load_key().is_none() {
        if let Ok(raw) = std::fs::read_to_string(config_path(&app).unwrap_or_default()) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                if let Some(k) = v.get("apiKey").and_then(|k| k.as_str()) {
                    if !k.trim().is_empty() && save_key(k).is_ok() {
                        eprintln!("[ai] 已把明文 API Key 迁移到系统凭据管理器");
                        if let Some(obj) = v.as_object() {
                            let mut clean = obj.clone();
                            clean.remove("apiKey");
                            if let Ok(pretty) = serde_json::to_string_pretty(&clean) {
                                let _ = std::fs::write(config_path(&app).unwrap_or_default(), pretty);
                            }
                        }
                    }
                }
            }
        }
    }
    AiConfigView {
        base_url: cfg.base_url,
        model: cfg.model,
        has_key: load_key().is_some(),
    }
}

#[tauri::command]
pub fn ai_config_set(app: tauri::AppHandle, config: AiConfig) -> Result<(), String> {
    save_config(&app, &config)
}

/// 保存 API Key 到系统凭据管理器（不落盘明文）。
#[tauri::command]
pub fn ai_config_set_key(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    save_key(&key)
}

/// 清除 API Key（从凭据管理器删除）。
#[tauri::command]
pub fn ai_config_clear_key() -> Result<(), String> {
    clear_key()
}

/// 对话：OpenAI 兼容 chat/completions（非流式）。
/// async 命令：阻塞的 reqwest 调用在异步运行时线程执行，不冻结主线程/UI。
#[tauri::command]
pub async fn ai_chat(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let cfg = load_config(&app);
    let api_key = load_key().ok_or_else(|| "未配置 API Key —— 请在设置页的「AI」区块填写".to_string())?;
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
            // 构建失败几乎不可能（仅 TLS 后端缺失等）；兜底默认客户端避免 panic
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    });

    let resp = client
        .post(&url)
        .bearer_auth(api_key.trim())
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
    if load_key().is_none() {
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

/// 对话（流式）：`stream: true`，SSE 逐段解析，增量经 `ai-chunk` 事件推给前端。
/// 命令在流结束（或出错）后 resolve；错误同样走 Err，由前端替换占位消息。
#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let cfg = load_config(&app);
    let api_key = load_key().ok_or_else(|| "未配置 API Key —— 请在设置页的「AI」区块填写".to_string())?;
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
        let detail = extract_error(&text);
        return Err(format!("API 返回 {status}: {detail}"));
    }

    // 逐块读取 SSE 流，按行解析（行可能跨 chunk，用 buf 缓存半行）
    let stream = resp.bytes_stream();
    consume_sse(stream, |text| {
        let _ = app.emit("ai-chunk", AiChunk { text });
    })
    .await?;
    Ok(())
}

/// 消费 SSE 字节流：按行解析（容忍跨 chunk 的半行 / CRLF），
/// 每个内容增量回调一次 `on_text`。可独立测试（内存流 / 本地 mock 服务器）。
async fn consume_sse<S, F>(stream: S, mut on_text: F) -> Result<(), String>
where
    S: futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Unpin,
    F: FnMut(String),
{
    use futures_util::StreamExt;
    let mut stream = stream;
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取流失败: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].to_string();
            buf = buf[pos + 1..].to_string();
            if let Some(text) = parse_sse_line(&line) {
                on_text(text);
            }
        }
    }
    // 尾部残余（无换行结尾的最后一行）
    if let Some(text) = parse_sse_line(buf.trim()) {
        on_text(text);
    }
    Ok(())
}

/// 解析一行 SSE：`data: {...}` 取 `choices[0].delta.content`；
/// 空行 / 注释行（`: ...`，keep-alive）/ `data: [DONE]` / 无内容 delta → None。
fn parse_sse_line(line: &str) -> Option<String> {
    let line = line.trim_end_matches('\r');
    if line.is_empty() || line.starts_with(':') {
        return None;
    }
    let data = line.strip_prefix("data:")?.trim();
    if data == "[DONE]" {
        return None;
    }
    let v: Value = serde_json::from_str(data).ok()?;
    v.pointer("/choices/0/delta/content")
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
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

#[cfg(test)]
mod tests {
    use super::{consume_sse, parse_sse_line};
    use serde_json::json;

    /// keyring 真实读写（Windows 凭据管理器）。需要桌面会话；CI 无会话时跳过。
    #[test]
    fn keyring_roundtrip() {
        let entry = keyring::Entry::new("com.toolbox.desktop.test", "unit").unwrap();
        let _ = entry.delete_credential();
        entry.set_password("hello-secret").unwrap();
        assert_eq!(entry.get_password().unwrap(), "hello-secret");
        entry.delete_credential().unwrap();
        // 删除后再读应为 NoEntry
        assert!(matches!(
            entry.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }

    /// SSE 行解析：正常 delta / [DONE] / 注释 / 空行 / 无内容 delta。
    #[test]
    fn sse_line_parsing() {
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"content":"你"}}]}"#).as_deref(),
            Some("你")
        );
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"content":""}}]}"#),
            None,
            "空内容 delta 应忽略"
        );
        assert_eq!(parse_sse_line("data: [DONE]"), None);
        assert_eq!(parse_sse_line(": keep-alive"), None, "注释行忽略");
        assert_eq!(parse_sse_line(""), None);
        assert_eq!(parse_sse_line("data: not-json"), None, "坏 JSON 忽略");
        // 带 \r 结尾（Windows 换行）
        assert_eq!(
            parse_sse_line("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\r").as_deref(),
            Some("好")
        );
    }

    /// consume_sse 处理分块到达：半行跨块拼接、CRLF、[DONE] 与注释行。
    #[test]
    fn consume_sse_joins_split_chunks() {
        let chunks: Vec<Result<bytes::Bytes, reqwest::Error>> = vec![
            Ok(bytes::Bytes::from(
                "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n",
            )),
            // 半行（JSON 被截断在中间）
            Ok(bytes::Bytes::from("data: {\"choices\":[{\"delta\":{\"cont")),
            Ok(bytes::Bytes::from(
                "ent\":\"好\"}}]}\r\ndata: [DONE]\n: keep-alive\n",
            )),
        ];
        let stream = futures_util::stream::iter(chunks);
        let mut texts = Vec::new();
        tauri::async_runtime::block_on(consume_sse(stream, |t| texts.push(t))).unwrap();
        assert_eq!(texts, vec!["你", "好"], "半行跨块应拼接解析");
    }

    /// 端到端：本地 SSE mock 服务器 + reqwest 流式请求 + consume_sse 解析。
    #[test]
    fn consume_sse_over_http() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for conn in listener.incoming().take(1) {
                let mut stream = conn.unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf); // 读走请求头
                let body = concat!(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"流\"}}]}\n",
                    "data: {\"choices\":[{\"delta\":{\"content\":\"式\"}}]}\n",
                    "data: [DONE]\n"
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
                stream.flush().unwrap();
            }
        });

        let url = format!("http://127.0.0.1:{port}/chat/completions");
        let client = reqwest::Client::new();
        let resp = tauri::async_runtime::block_on(
            client
                .post(&url)
                .json(&json!({ "stream": true }))
                .send(),
        )
        .unwrap();
        assert!(resp.status().is_success());
        let mut texts = Vec::new();
        tauri::async_runtime::block_on(consume_sse(resp.bytes_stream(), |t| texts.push(t)))
            .unwrap();
        assert_eq!(texts, vec!["流", "式"], "HTTP 流式响应应逐段解析");
        server.join().unwrap();
    }
}
