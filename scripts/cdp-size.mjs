const t = await fetch("http://localhost:9226/json").then((r) => r.json());
const page = t.find((x) => x.type === "page" && /1420/.test(x.url));
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
await send("Runtime.enable");
const r = await send("Runtime.evaluate", {
  expression: `JSON.stringify({ win: [innerWidth, innerHeight], hasApp: !!document.querySelector('.app') })`,
  returnByValue: true,
});
console.log(r.result.result.value);
ws.close();
process.exit(0);
