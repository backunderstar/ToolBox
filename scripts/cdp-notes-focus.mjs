// 聚焦笔记视图：量各面板宽度 + 高度链，检查折叠状态
const targets = await fetch("http://localhost:9225/json").then((r) => r.json());
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
await new Promise((r) => setTimeout(r, 1000));

const r = await ev(`(() => {
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
  return JSON.stringify({
    win: [innerWidth, innerHeight],
    sidebar: rect('.sidebar'),
    files: rect('.files-pane'),
    filesCollapsed: !!document.querySelector('.files-pane.collapsed'),
    main: rect('.main'),
    notes: rect('.notes'),
    editorArea: rect('.editor-area'),
    editorBody: rect('.editor-body'),
    vditorToolbar: rect('.editor-host .vditor-toolbar'),
    vditorContent: rect('.editor-host .vditor-content'),
    vditorIr: rect('.editor-host .vditor-ir'),
    navCollapsed: !!document.querySelector('.sidebar.collapsed'),
    layoutPrefs: localStorage.getItem('toolbox.layout'),
    view: (document.querySelector('.sidebar .nav-item.active')||{}).title || null,
  });
})()`);
console.log(r);
ws.close();
process.exit(0);
