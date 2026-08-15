// 检查工具栏按钮计算宽度
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
await new Promise((r) => setTimeout(r, 1500));
const out = await ev(`(() => {
  const tb = document.querySelector('.editor-host .vditor-toolbar');
  const btns = [...document.querySelectorAll('.editor-host .vditor-toolbar__item button')];
  const computed = btns[0] ? getComputedStyle(btns[0]) : null;
  return JSON.stringify({
    toolbarH: tb ? Math.round(tb.getBoundingClientRect().height) : null,
    editorW: (() => { const el = document.querySelector('.editor-area'); return el ? Math.round(el.getBoundingClientRect().width) : null; })(),
    itemCount: btns.length,
    btnW: computed ? computed.width : null,
    btnPadding: computed ? computed.padding : null,
    dividerMargin: (() => { const d = document.querySelector('.editor-host .vditor-toolbar__divider'); return d ? getComputedStyle(d).margin : null; })(),
    hasFullscreen: !!document.querySelector('.editor-host .vditor-toolbar button[data-type="fullscreen"]'),
  });
})()`);
console.log(out);
await send("Emulation.clearDeviceMetricsOverride", {});
ws.close();
process.exit(0);
