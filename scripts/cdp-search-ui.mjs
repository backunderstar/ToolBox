// UI 搜索回归：TopBar 搜索框输入 → 结果面板渲染。
// 用法: node scripts/cdp-search-ui.mjs [port]
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri\.localhost/.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EVAL_ERR:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1500));

// 进入笔记视图（若在欢迎页）
await ev(`(() => { const b = document.querySelector('.welcome .btn-primary'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 2500));

// 在 TopBar 搜索框输入（FTS 命中词）
const typed = await ev(`(async () => {
  const input = document.querySelector('header input[placeholder*="搜索笔记"]');
  if (!input) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '工作相关');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1500)); // 等 debounce + 搜索结果
  return 'TYPED';
})()`);
console.log("[1] 输入:", typed);

const results = await ev(`(() => {
  const items = [...document.querySelectorAll('.search-list .result-item')];
  return JSON.stringify({
    count: items.length,
    first: items[0] ? {
      title: (items[0].querySelector('.result-title') ?? {}).textContent,
      snippet: (items[0].querySelector('.result-snippet') ?? {}).textContent?.slice(0, 40),
    } : null,
  });
})()`);
console.log("[2] 搜索结果:", results);

// 清空搜索 → 回到笔记视图
await ev(`(() => {
  const input = document.querySelector('header input[placeholder*="搜索笔记"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1200));

// 短词（<3 字 LIKE 兜底）
await ev(`(() => {
  const input = document.querySelector('header input[placeholder*="搜索笔记"]');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '进度');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await new Promise((r) => setTimeout(r, 1500));
const short = await ev(`(() => {
  const items = [...document.querySelectorAll('.search-list .result-item')];
  return JSON.stringify({ count: items.length });
})()`);
console.log("[3] 短词'进度'结果:", short);

// 错误收集
let errs = 0;
for (const e of events) {
  if (e.method === "Runtime.exceptionThrown") { errs++; console.log("[exception]", e.params.exceptionDetails.text); }
  if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
    const t = e.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { errs++; console.log("[console.error]", t); }
  }
}
console.log(`[4] 错误数: ${errs}`);
ws.close();
if (errs > 0) process.exit(1);
console.log("=== DONE ===");
process.exit(0);
