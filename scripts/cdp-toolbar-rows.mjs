// 枚举工具栏各 item 的行位置与宽度
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
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 1200));
const out = await ev(`(() => {
  const tb = document.querySelector('.editor-host .vditor-toolbar');
  const tbR = tb.getBoundingClientRect();
  const items = [...tb.children].map((it) => {
    const r = it.getBoundingClientRect();
    const b = it.querySelector('button');
    return {
      c: it.className.includes('divider') ? 'D' : (b ? (b.getAttribute('data-type') || b.getAttribute('data-tag') || '?') : '?'),
      l: Math.round(r.left - tbR.left),
      r: Math.round(r.right - tbR.left),
      w: Math.round(r.width),
      top: Math.round(r.top - tbR.top),
    };
  });
  return JSON.stringify({ toolbarW: Math.round(tbR.width), items });
})()`);
console.log(out);
await send("Emulation.clearDeviceMetricsOverride", {});
ws.close();
process.exit(0);
