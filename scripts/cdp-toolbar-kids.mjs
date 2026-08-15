// 打印工具栏前 3 个子元素的 HTML 结构
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
const out = await ev(`(() => {
  const tb = document.querySelector('.editor-host .vditor-toolbar');
  const kids = [...tb.children];
  const first = kids.slice(0, 3).map(k => k.outerHTML.slice(0, 180));
  const last2 = kids.slice(-2).map(k => k.outerHTML.slice(0, 180));
  return JSON.stringify({ childCount: kids.length, first, last2, aiItem: kids.find(k => (k.querySelector('button')||{}).getAttribute && (k.querySelector('button')).getAttribute('data-type') === 'ai-summary')?.outerHTML.slice(0, 300) });
})()`);
console.log(out);
ws.close();
process.exit(0);
