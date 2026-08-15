// E2E 验证：笔记目录 notes/ + 无最近打开
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
await new Promise((r) => setTimeout(r, 1200));

// 进入笔记视图
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '笔记'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 2000));

const tree = await ev(`JSON.stringify({
  vaultTitle: (document.querySelector('.files-title')||{}).title || null,
  fileNames: [...document.querySelectorAll('.tree-name')].map(n => n.textContent),
  hasRecent: !!document.querySelector('.recent-block'),
  hasRecentLabel: !!document.querySelector('.recent-label'),
  dirNames: [...document.querySelectorAll('.tree-row .tree-name')].filter(n => n.textContent === 'data' || n.textContent === 'plugins').map(n => n.textContent),
})`);
console.log("文件树:", tree);

// 新建笔记
const before = await ev(`(() => { const b = [...document.querySelectorAll('.files-header button')].find(x => x.title === '新建笔记'); if (b) b.click(); return !!b; })()`);
console.log("新建点击:", before);
await new Promise((r) => setTimeout(r, 2000));
const after = await ev(`JSON.stringify({
  activePath: (document.querySelector('.editor-title')||{}).textContent || null,
  fileNames: [...document.querySelectorAll('.tree-name')].map(n => n.textContent),
})`);
console.log("新建后:", after);

// 打开一个已存在的笔记（迁移后的）
const opened = await ev(`(() => { const names = [...document.querySelectorAll('.tree-name')]; const n = names.find(x => /示例笔记/.test(x.textContent || '')); if (n) { n.closest('.tree-row').click(); return n.textContent; } return 'no 示例笔记'; })()`);
console.log("打开:", opened);
await new Promise((r) => setTimeout(r, 1500));
const editor = await ev(`JSON.stringify({
  activePath: (document.querySelector('.editor-title')||{}).textContent || null,
  editorHasContent: ((document.querySelector('.editor-host .vditor-ir')||{}).textContent || '').length > 0,
})`);
console.log("编辑器:", editor);
ws.close();
process.exit(0);
