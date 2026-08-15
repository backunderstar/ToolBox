// E2E 验证 AI API Key 凭据管理：不落盘 + hasKey + 迁移
const targets = await fetch("http://localhost:9226/json").then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420/.test(t.url));
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
  if (r.result?.exceptionDetails) return "EXC: " + JSON.stringify(r.result.exceptionDetails).slice(0, 200);
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1500));

const invoke = (cmd, args = {}) =>
  ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(v => JSON.stringify(v)).catch(e => 'ERR:' + e)`);

// 1. 清除旧状态
await invoke("ai_config_clear_key");
const before = await invoke("ai_config_get");
console.log("初始:", before);

// 2. 存 Key（凭据管理器）
console.log("存 Key:", await invoke("ai_config_set_key", { key: "sk-test-123456" }));
const afterSet = await invoke("ai_config_get");
console.log("存后 hasKey:", afterSet);
console.log("返回值含明文吗:", afterSet.includes("sk-test-123456") ? "✗ 泄露!" : "✓ 不含");

// 3. 存配置（baseUrl/model）
console.log("存配置:", await invoke("ai_config_set", { config: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" } }));

// 4. 清除 Key
console.log("清 Key:", await invoke("ai_config_clear_key"));
const afterClear = await invoke("ai_config_get");
console.log("清后:", afterClear);
ws.close();
process.exit(0);
