// 检查 vditor 工具栏下拉菜单 DOM 位置
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
const out = await ev(`JSON.stringify({
  menus: [...document.querySelectorAll('.vditor-menu')].map(m => ({
    cls: m.className,
    parent: m.parentElement ? m.parentElement.className : null,
    parentParent: m.parentElement && m.parentElement.parentElement ? m.parentElement.parentElement.className : null
  })),
  toolbarOverflow: getComputedStyle(document.querySelector('.editor-host .vditor-toolbar')).overflow,
  toolbarItemCount: document.querySelectorAll('.editor-host .vditor-toolbar__item').length,
})`);
console.log(out);
ws.close();
process.exit(0);
