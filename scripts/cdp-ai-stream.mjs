// AI 流式 E2E：本地 SSE mock 服务器 → 真实 UI 打字机效果。
// 安全：仅当系统未配置真实 API Key 时运行（避免覆盖用户凭据）；测完恢复配置并清理 mock key。
import http from "node:http";

const PORT = process.argv[2] ?? "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri/.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
const invoke = (cmd, args) => {
  const a = JSON.stringify(args ?? {});
  return ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${a}).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e)`);
};
const waitFor = async (expr, timeoutMs = 20000, interval = 300) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await ev(expr);
    if (v) return v;
    await sleep(interval);
  }
  return false;
};

await send("Runtime.enable");
await sleep(800);

/* 1. 安全检查：已有真实 Key 则跳过（不碰用户凭据） */
const cfgBefore = JSON.parse(await invoke("ai_config_get"));
console.log("[guard] hasKey:", cfgBefore.hasKey);
if (cfgBefore.hasKey) {
  console.log("AI_STREAM_SKIPPED (真实 Key 已配置，跳过 UI E2E；Rust 测试已覆盖链路)");
  ws.close();
  process.exit(0);
}

/* 2. 本地 SSE mock 服务器（分段 + 延迟，验证打字机效果） */
const parts = ["你好", "，这是", "流式", "测试"];
const srv = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let i = 0;
  const timer = setInterval(() => {
    if (i < parts.length) {
      res.write(`data: {"choices":[{"delta":{"content":${JSON.stringify(parts[i])}}}]}\n\n`);
      i++;
    } else {
      res.write("data: [DONE]\n\n");
      clearInterval(timer);
      res.end();
    }
  }, 90);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const mockPort = srv.address().port;
console.log("[mock] SSE server on", mockPort);

/* 3. 配置 AI → mock */
const beforeCfg = { baseUrl: cfgBefore.baseUrl, model: cfgBefore.model };
await invoke("ai_config_set", { config: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: "mock" } });
const keySet = await invoke("ai_config_set_key", { key: "mock-key" });
console.log("[config] key set:", keySet);

try {
  /* 4. 进 AI 视图，发送消息 */
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('AI 整理')); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  await ev(`(() => {
    const input = document.querySelector('.ai-chat-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '测试流式输出');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  // 等 React 状态跟上（按钮从 disabled 变可用）再点击
  const btnReady = await waitFor(`(() => { const b = document.querySelector('.btn-primary-ai'); return b && !b.disabled; })()`, 5000, 200);
  console.log("[send] btn ready:", btnReady ? "OK" : "TIMEOUT");
  await sleep(200);
  await ev(`(() => { const b = document.querySelector('.btn-primary-ai'); if (b) b.click(); return true; })()`);

  /* 5. 轮询消息内容：记录中间态长度（打字机证据）与最终文本 */
  let maxLen = 0;
  let sawIntermediate = false;
  let finalText = "";
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const contents = await ev(`[...document.querySelectorAll('.ai-msg-content')].map(e => e.textContent)`);
    const aiMsg = contents[contents.length - 1] ?? "";
    if (aiMsg && aiMsg !== "思考中…") {
      if (aiMsg.length < 4 && aiMsg.length > 0) sawIntermediate = true;
      maxLen = Math.max(maxLen, aiMsg.length);
      finalText = aiMsg;
    }
    const done = await ev(`!document.querySelector('.btn-primary-ai')?.textContent.includes('思考中')`);
    if (done && finalText.length > 0) break;
    await sleep(150);
  }

  console.log("[stream] final:", JSON.stringify(finalText));
  console.log("[stream] maxLen:", maxLen, "sawIntermediate:", sawIntermediate);
  const textOk = finalText === "你好，这是流式测试";
  console.log("[stream] text:", textOk ? "OK" : "FAIL");
  console.log("[stream] typewriter:", sawIntermediate ? "OK" : "FAIL");
  const pass = textOk && sawIntermediate;
  console.log(pass ? "AI_STREAM_PASS" : "AI_STREAM_FAIL");
  process.exitCode = pass ? 0 : 1;
} finally {
  /* 6. 清理：恢复配置 + 清 mock key */
  await invoke("ai_config_set", { config: beforeCfg });
  await invoke("ai_config_clear_key");
  srv.close();
  console.log("[cleanup] config restored, key cleared");
  ws.close();
  await sleep(300);
}
process.exit(process.exitCode ?? 0);
