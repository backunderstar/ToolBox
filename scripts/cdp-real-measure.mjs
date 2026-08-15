// 真实应用（WebView2 9226）测量：编辑器高度链 + 各视图宽度空白
const PORT = "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
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
await new Promise((r) => setTimeout(r, 1500));

// 进入笔记视图，必要时打开第一篇笔记
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '笔记'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1200));
const hasEditor = await ev(`!!document.querySelector('.editor-host')`);
if (!hasEditor) {
  await ev(`(() => { const row = document.querySelector('.tree-row .tree-name'); if (row) { row.closest('.tree-row').click(); return true; } return false; })()`);
  await new Promise((r) => setTimeout(r, 1200));
}

const h = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? Math.round(el.getBoundingClientRect().height) : null; })()`;
const chain = await ev(`JSON.stringify({
  win: [innerWidth, innerHeight],
  topbar: ${h(".topbar")}, statusbar: ${h(".statusbar")}, main: ${h(".main")},
  editorArea: ${h(".editor-area")}, editorHeader: ${h(".editor-header")},
  backlinks: ${h(".backlinks")}, editorBody: ${h(".editor-body")},
  vditorToolbar: ${h(".editor-host .vditor-toolbar")},
  vditorContent: ${h(".editor-host .vditor-content")}, vditorIr: ${h(".editor-host .vditor-ir")},
})`);
console.log("== 真实应用编辑器高度链 ==");
console.log(JSON.parse(chain));

const navMap = { overview: "概览", plugins: "插件", tools: "数据工具", checklist: "清单", records: "记录", ai: "AI 整理", blog: "博客发布", settings: "设置" };
console.log("== 真实应用各视图宽度 ==");
for (const [v, label] of Object.entries(navMap)) {
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 700));
  const out = await ev(`(() => {
    const main = document.querySelector('.main'); const mr = main.getBoundingClientRect();
    const inner = document.querySelector('.main > div'); const ir = inner ? inner.getBoundingClientRect() : null;
    const cols = ['.plugin-list', '.tool-grid', '.tool-workspace', '.settings-sections', '.ai-body', '.blog-detail', '.checklist-editor', '.record-editor'];
    const found = {};
    for (const sel of cols) {
      const el = document.querySelector(sel);
      if (el) { const r = el.getBoundingClientRect(); found[sel] = { w: Math.round(r.width), blank: Math.round(mr.right - r.right) }; }
    }
    return JSON.stringify({ mainW: Math.round(mr.width), innerW: ir ? Math.round(ir.width) : null, found });
  })()`);
  const d = JSON.parse(out);
  const parts = [`[${v.padEnd(9)}] main=${d.mainW}`];
  for (const [sel, r] of Object.entries(d.found)) parts.push(`${sel.replace(/^\./, "")}: ${r.w}px/空白${r.blank}px`);
  console.log(parts.join(" | "));
}
ws.close();
process.exit(0);
