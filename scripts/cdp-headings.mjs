// 点开 headings 下拉，检查菜单 DOM 结构
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
await new Promise((r) => setTimeout(r, 800));

// 找到 headings 按钮并点击
const btn = await ev(`(() => {
  const items = [...document.querySelectorAll('.editor-host .vditor-toolbar__item')];
  const el = items.find(i => i.title === '标题' || (i.querySelector('button')||{}).title === '标题' || (i.getAttribute('title')||'').includes('标题'));
  if (el) { (el.querySelector('button') || el).click(); return 'clicked: ' + el.outerHTML.slice(0, 200); }
  return 'not found; items: ' + items.map(i => (i.getAttribute('title')||'') + '/' + ((i.querySelector('button')||{}).title||'')).join(', ');
})()`);
console.log("按钮:", btn);
await new Promise((r) => setTimeout(r, 500));

const dom = await ev(`JSON.stringify({
  menus: [...document.querySelectorAll('.vditor-menu')].map(m => ({
    cls: m.className.slice(0, 60),
    parent: m.parentElement ? m.parentElement.className.slice(0, 60) : null,
    parentTag: m.parentElement ? m.parentElement.tagName : null,
    inToolbar: !!(m.closest('.vditor-toolbar')),
    rect: (() => { const r = m.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; })()
  })),
})`);
console.log("菜单:", dom);
ws.close();
process.exit(0);
