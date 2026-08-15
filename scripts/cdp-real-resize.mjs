// 真实应用：CDP 模拟窗口 resize，验证编辑器是否跟随
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
await send("Page.enable");
await new Promise((r) => setTimeout(r, 600));

const measure = `(() => {
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { h: Math.round(b.height), bottom: Math.round(b.bottom) }; };
  return JSON.stringify({
    win: [innerWidth, innerHeight],
    editorBody: rect('.editor-body'),
    vditorToolbar: rect('.editor-host .vditor-toolbar'),
    vditorContent: rect('.editor-host .vditor-content'),
    statusbarTop: (() => { const el = document.querySelector('.statusbar'); return el ? Math.round(el.getBoundingClientRect().top) : null; })(),
  });
})()`;
const show = async (label) => { console.log(label, await ev(measure)); };

await show("初始  :");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 1500));
await show("放大后:");
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
await new Promise((r) => setTimeout(r, 1500));
await show("缩小后:");
await send("Emulation.clearDeviceMetricsOverride", {});
await new Promise((r) => setTimeout(r, 1200));
await show("恢复后:");
ws.close();
process.exit(0);
