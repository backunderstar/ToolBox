//! SSE 流式解析（由宿主 core/ai.rs 移植，可独立测试）。

use bytes::Bytes;
use futures_util::Stream;
use serde_json::Value;

/// 消费 SSE 字节流：按行解析（容忍跨 chunk 的半行 / CRLF），
/// 每个内容增量回调一次 `on_text`。
pub async fn consume_sse<S, F>(stream: S, mut on_text: F) -> Result<(), String>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Unpin,
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
pub fn parse_sse_line(line: &str) -> Option<String> {
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

/// 从错误响应体提取可读错误信息。
pub fn extract_error(body: &str) -> String {
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

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

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
        assert_eq!(
            parse_sse_line("data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\r").as_deref(),
            Some("好")
        );
    }

    #[test]
    fn consume_sse_joins_split_chunks() {
        let chunks: Vec<Result<bytes::Bytes, reqwest::Error>> = vec![
            Ok(bytes::Bytes::from(
                "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n",
            )),
            Ok(bytes::Bytes::from("data: {\"choices\":[{\"delta\":{\"cont")),
            Ok(bytes::Bytes::from(
                "ent\":\"好\"}}]}\r\ndata: [DONE]\n: keep-alive\n",
            )),
        ];
        let stream = futures_util::stream::iter(chunks);
        let mut texts = Vec::new();
        rt().block_on(consume_sse(stream, |t| texts.push(t))).unwrap();
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
                let _ = stream.read(&mut buf);
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
        let resp = rt().block_on(client.post(&url).json(&serde_json::json!({ "stream": true })).send()).unwrap();
        assert!(resp.status().is_success());
        let mut texts = Vec::new();
        rt().block_on(consume_sse(resp.bytes_stream(), |t| texts.push(t))).unwrap();
        assert_eq!(texts, vec!["流", "式"], "HTTP 流式响应应逐段解析");
        server.join().unwrap();
    }
}
