// 检查工具栏及其首个 item 的计算样式，找出 29px 偏移来源
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
  const tbC = getComputedStyle(tb);
  const first = tb.children[0];
  const firstC = getComputedStyle(first);
  const host = document.querySelector('.editor-host');
  const hostC = getComputedStyle(host);
  // 检查 toolbar 内的非 item/divider 子元素
  const odd = [...tb.children].filter(k => !k.className.includes('vditor-toolbar__item') && !k.className.includes('vditor-toolbar__divider'));
  return JSON.stringify({
    tbPadding: tbC.padding,
    tbMargin: tbC.margin,
    tbWidth: tbC.width,
    firstMargin: firstC.margin,
    firstPadding: firstC.padding,
    firstDisplay: firstC.display,
    hostPadding: hostC.padding,
    hostBorder: hostC.border,
    oddChildren: odd.map(o => ({ cls: o.className, html: o.outerHTML.slice(0, 150) })),
    toolbarRect: (() => { const r = tb.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width) }; })(),
  });
})()`);
console.log(out);
ws.close();
process.exit(0);
