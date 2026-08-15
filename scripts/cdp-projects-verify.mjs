// 复验：归档后"进行中"不应出现 archive 目录
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
await new Promise((r) => setTimeout(r, 1500));

await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '项目'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1500));
const out = await ev(`JSON.stringify([...document.querySelectorAll('.projects-section')].map(s => ({
  title: (s.querySelector('.section-title')||{}).textContent,
  names: [...s.querySelectorAll('.project-card-name')].map(n => n.textContent),
})))`);
console.log(out);
ws.close();
process.exit(0);
