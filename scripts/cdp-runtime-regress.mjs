// cdp-runtime-regress.mjs — 统一运行时回归：webview 插件（text-stats）仍可用 + blog ui 仍工作
const PORT = process.argv[2] ?? "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page =
  targets.find((t) => t.type === "page" && /1420|tauri/.test(t.url)) ??
  targets.find((t) => t.type === "page");
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
const waitFor = async (expr, desc, timeoutMs = 25000, interval = 300) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ev(expr)) return true;
    await sleep(interval);
  }
  throw new Error(`超时等待: ${desc}`);
};
const clickText = async (selector, text) => {
  const ok = await ev(
    `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = els.find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`
  );
  if (!ok) throw new Error(`未找到可点元素 ${selector}「${text}」`);
};
const log = (s) => console.log(s);

await send("Runtime.enable");
await sleep(600);

// ---- 1. webview 插件（text-stats）经统一运行时加载：启用 → 就绪（命令注册成功）----
await clickText(".nav-item", "插件");
await waitFor(`[...document.querySelectorAll('.plugin-card')].some(c => c.textContent.includes('文本统计'))`, "text-stats 卡片");
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.textContent.includes('文本统计'));
  const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '启用');
  if (b) b.click();
  return true;
})()`);
await waitFor(
  `(() => { const c = [...document.querySelectorAll('.plugin-card')].find(x => x.textContent.includes('文本统计')); return c ? c.textContent.includes('就绪') : false; })()`,
  "text-stats 就绪（统一运行时加载成功）"
);
log("PASS webview 插件 text-stats 经统一运行时加载（命令注册成功）");

// ---- 2. 博客插件自带前端仍工作 ----
await clickText(".nav-item", "博客发布");
await waitFor(`!!document.querySelector('.blog-plugin-ui')`, "插件自带界面挂载");
await waitFor(`document.querySelectorAll('.blog-ui-row').length >= 1`, "列表经桥加载");
log("PASS 博客插件自带前端（统一桥）仍工作");

log("\n========== RUNTIME_REGRESS_PASS ==========");
process.exit(0);
