// 用 /json/new 新建一个 1420 mock 页面并等待渲染
const PORT = "9225";
const URL = "http://localhost:1420/?mock=1";
const target = await fetch(
  `http://localhost:${PORT}/json/new?` + encodeURIComponent(URL),
  { method: "PUT" }
).then((r) => r.json());
console.log("created:", target.id, target.url);
const ws = new WebSocket(target.webSocketDebuggerUrl);
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
await new Promise((r) => setTimeout(r, 7000));
const r = await send("Runtime.evaluate", {
  expression: `JSON.stringify({ url: location.href, hasApp: !!document.querySelector('.app'), hasNav: !!document.querySelector('.sidebar'), rootLen: (document.querySelector('#root')||{}).innerHTML ? document.querySelector('#root').innerHTML.length : 0 })`,
  returnByValue: true,
});
console.log(r.result.result.value);
ws.close();
process.exit(0);
