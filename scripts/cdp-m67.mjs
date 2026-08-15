// CDP smoke test for M6 AI + M7 Blog views (mock mode; IPC failures must degrade gracefully).
const PORT = process.argv[2] ?? "9225";
const URL = "http://localhost:1420/?mock=1";
const WAIT_SEC = Number(process.argv[3] ?? 5);

const target = await fetch(
  `http://localhost:${PORT}/json/new?` + encodeURIComponent(URL),
  { method: "PUT" }
).then((r) => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("WS error: " + e.message)); });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickNav = (label) => evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('${label}'));
  b?.click(); return !!b;
})()`);

await sleep(WAIT_SEC * 1000);

// 1. AI view renders with empty state
console.log("[1]", await clickNav("AI 整理"));
await sleep(500);
console.log("[1] ai view:", await evalJs(`(() => JSON.stringify({
  header: document.querySelector('.ai-view .view-header h1')?.textContent,
  empty: !!document.querySelector('.ai-empty'),
  presets: [...document.querySelectorAll('.ai-presets .btn')].map(b => b.textContent.trim()),
  hasConfigBtn: document.body.textContent.includes('配置 AI')
}))()`));

// 2. Send message without key -> graceful error
const aiMsg = await evalJs(`(async () => {
  const input = document.querySelector('.ai-chat-input');
  if (!input) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '你好');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300)); // wait React re-render so send button enables
  const btn = [...document.querySelectorAll('.ai-input-row .btn-primary-ai')][0];
  if (!btn) return 'NO_SEND_BTN';
  btn.click();
  await new Promise(r => setTimeout(r, 1200));
  const msgs = [...document.querySelectorAll('.ai-msg .ai-msg-content')];
  return JSON.stringify({ count: msgs.length, last: msgs.at(-1)?.textContent?.slice(0, 60) ?? '' });
})()`);
console.log("[2] no-key send:", JSON.stringify(aiMsg));

// 3. Settings AI section renders
console.log("[3]", await clickNav("设置"));
await sleep(500);
console.log("[3] ai settings:", await evalJs(`(() => JSON.stringify({
  hasSection: document.body.textContent.includes('AI 提供商'),
  hasTestBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('测试连接')),
  modelInput: document.querySelector('.ai-input-sm')?.value
}))()`));

// 4. Blog view renders (empty in mock, no crash)
console.log("[4]", await clickNav("博客发布"));
await sleep(600);
console.log("[4] blog view:", await evalJs(`(() => JSON.stringify({
  header: document.querySelector('.blog-view .view-header h1')?.textContent ?? document.querySelector('.blog-pane-title')?.textContent,
  hasGenerate: [...document.querySelectorAll('button')].some(b => b.textContent.includes('生成站点')),
  emptyHint: document.querySelector('.blog-list .tree-empty')?.textContent?.trim().slice(0, 30) ?? null
}))()`));

console.log("--- errors ---");
let n = 0;
for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") { n++; console.log("[exception]", ev.params.exceptionDetails.exception?.description?.split("\n").slice(0,4).join(" | ")); }
  if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
    const t = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { n++; console.log("[console.error]", t.split("\n")[0].slice(0,110)); }
  }
}
console.log(`real errors: ${n}`);
ws.close();
console.log("=== M67 SMOKE DONE ===");
process.exit(0);
