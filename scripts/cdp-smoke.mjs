// 冒烟：ping IPC + 确认 React 已挂载（侧边栏存在），用于验证单实例插件未破坏 UI
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
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
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 800));

const ping = await ev(`window.__TAURI_INTERNALS__.invoke('ping').then(r => 'PING_OK ' + r.message + ' v' + r.coreVersion).catch(e => 'PING_ERR ' + e)`);
const nav = await ev(`!!document.querySelector('nav') ? 'NAV_OK' : 'NAV_MISSING'`);
const views = await ev(`Array.from(document.querySelectorAll('nav button, nav a')).map(b => b.textContent.trim()).filter(Boolean).slice(0, 12).join('|')`);
console.log("[smoke]", ping, "|", nav);
console.log("[views]", views);
ws.close();
process.exit(0);
