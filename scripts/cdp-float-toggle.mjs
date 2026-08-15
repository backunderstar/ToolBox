// 精确诊断：间隔调用 float_toggle，观察返回值是否交替 + Win32 可见性
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
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1000));

for (let i = 1; i <= 4; i++) {
  const r = await ev(`window.__TAURI_INTERNALS__.invoke('float_toggle').then(v => 'visible=' + v).catch(e => 'err ' + e)`);
  console.log(`toggle#${i}:`, r);
  await new Promise((r) => setTimeout(r, 1800));
}
ws.close();
process.exit(0);
