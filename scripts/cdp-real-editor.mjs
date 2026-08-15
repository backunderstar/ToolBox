// 真实应用：进入笔记视图 → 打开第一篇笔记 → 测量编辑器高度链
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

// 确保在笔记视图
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '笔记'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1500));

const state = await ev(`JSON.stringify({
  vaultTitle: (document.querySelector('.files-title')||{}).title || null,
  files: [...document.querySelectorAll('.tree-name')].map(n => n.textContent),
  activePath: (document.querySelector('.editor-title')||{}).textContent || null,
  empty: !!document.querySelector('.empty-state'),
})`);
console.log("状态:", state);

if (!(JSON.parse(state).activePath)) {
  const clicked = await ev(`(() => { const names = [...document.querySelectorAll('.tree-name')]; const n = names.find(x => /\.md$/i.test(x.textContent || '')); if (!n) return 'no-md'; n.closest('.tree-row').click(); return 'clicked:' + n.textContent; })()`);
  console.log("点击:", clicked);
  await new Promise((r) => setTimeout(r, 1500));
}

const h = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? Math.round(el.getBoundingClientRect().height) : null; })()`;
const chain = await ev(`JSON.stringify({
  win: [innerWidth, innerHeight],
  body: ${h(".body")}, main: ${h(".main")},
  editorArea: ${h(".editor-area")}, editorHeader: ${h(".editor-header")},
  backlinks: ${h(".backlinks")}, editorBody: ${h(".editor-body")},
  editorHost: ${h(".editor-host")},
  vditorToolbar: ${h(".editor-host .vditor-toolbar")},
  vditorContent: ${h(".editor-host .vditor-content")},
  vditorIr: ${h(".editor-host .vditor-ir")},
  editorBodyBottom: (() => { const el = document.querySelector('.editor-body'); return el ? Math.round(el.getBoundingClientRect().bottom) : null; })(),
  statusbarTop: (() => { const el = document.querySelector('.statusbar'); return el ? Math.round(el.getBoundingClientRect().top) : null; })(),
})`);
console.log("== 编辑器高度链 ==");
console.log(JSON.parse(chain));
ws.close();
process.exit(0);
