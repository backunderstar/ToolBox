// Real-app theme E2E: switch themes in real WebView2, verify CSS vars + persistence.
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url));
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(e.message)); });
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

// 1. Go to settings
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('设置'));
  b?.click(); return 'ok';
})()`);
await sleep(800);
console.log("[1] theme cards:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.theme-card-name')].map(x => x.textContent)
))()`));

// 2. Warm theme
await evalJs(`(() => {
  const c = [...document.querySelectorAll('.theme-card')].find(x => x.textContent.includes('暖色'));
  c?.click(); return 'ok';
})()`);
await sleep(500);
console.log("[2] warm:", await evalJs(`(() => JSON.stringify({
  themeId: document.documentElement.dataset.themeId,
  base: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  stored: localStorage.getItem('toolbox.theme')
}))()`));

// 3. Dark via topbar toggle (from warm light -> default-dark)
await evalJs(`(() => {
  const b = document.querySelector('.topbar .icon-btn:last-child');
  b?.click(); return 'ok';
})()`);
await sleep(400);
console.log("[3] toggled:", await evalJs(`(() => JSON.stringify({
  themeId: document.documentElement.dataset.themeId,
  base: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
}))()`));

// 4. Reload: persistence across real app restart context
await evalJs(`location.reload()`);
await sleep(3500);
console.log("[4] after reload:", await evalJs(`(() => JSON.stringify({
  themeId: document.documentElement.dataset.themeId,
  base: document.documentElement.dataset.theme
}))()`));

console.log("--- errors ---");
let n = 0;
for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") { n++; console.log("[exception]", ev.params.exceptionDetails.exception?.description?.split("\n").slice(0,4).join(" | ")); }
  if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
    const t = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { n++; console.log("[console.error]", t.split("\n")[0].slice(0,120)); }
  }
}
console.log(`real errors: ${n}`);
ws.close();
console.log("=== THEME E2E DONE ===");
process.exit(0);
