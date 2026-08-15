// 本轮 E2E：插件卸载（UI 流程）+ 断链提示。
// 用法: node scripts/cdp-batch3.mjs [port]
const PORT = process.argv[2] ?? "9226";
const V = "D:\\WORKSPACE\\ToolBox\\src-tauri\\target\\e2e-vault";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri\.localhost/.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EVAL_ERR:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1800));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 0. 创建临时插件（webview，简单入口）
const created = await ev(`(async () => {
  const fs = (rel, content) => window.__TAURI_INTERNALS__.invoke('fs_write', { vault: ${JSON.stringify(V)}, rel, content });
  await fs('plugins/e2e-tmp/plugin.json', JSON.stringify({ id: 'e2e-tmp', name: 'E2E 临时插件', version: '0.1.0', runtime: 'webview', entry: 'main.js', permissions: [] }));
  await fs('plugins/e2e-tmp/main.js', 'api.app.registerCommand({ id: "hi", name: "打招呼", run: async () => ({ ok: true }) });');
  return 'OK';
})()`);
console.log("[0] 创建临时插件:", created);

// 1. 插件页：临时插件出现
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('插件')); if (b) b.click(); return !!b; })()`);
await sleep(1500);
await ev(`(() => { const b = [...document.querySelectorAll('.plugin-actions button')].find(x => x.textContent === '刷新'); if (b) b.click(); return !!b; })()`);
await sleep(1500);
const card = await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => (x.querySelector('.plugin-title h2') || {}).textContent === 'E2E 临时插件');
  return c ? 'FOUND' : 'MISSING';
})()`);
console.log("[1] 临时插件卡片:", card);
if (card !== "FOUND") { console.log("FAIL: 插件未出现"); process.exit(1); }

// 2. 点卸载 → ConfirmDialog → 确认
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => (x.querySelector('.plugin-title h2') || {}).textContent === 'E2E 临时插件');
  const b = [...c.querySelectorAll('button')].find(x => x.textContent.includes('卸载'));
  if (b) b.click();
  return !!b;
})()`);
await sleep(500);
const dialog = await ev(`(() => {
  const d = document.querySelector('.confirm-dialog');
  return d ? (d.querySelector('.confirm-title') || {}).textContent : null;
})()`);
console.log("[2] 卸载确认弹窗:", dialog);
if (!dialog) { console.log("FAIL: 应弹出卸载确认"); process.exit(1); }
await ev(`(() => { const d = document.querySelector('.confirm-dialog'); const b = [...d.querySelectorAll('button')].find(x => x.textContent === '卸载'); b?.click(); return !!b; })()`);
await sleep(1500);

// 3. 插件应消失 + 目录已删
const gone = await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => (x.querySelector('.plugin-title h2') || {}).textContent === 'E2E 临时插件');
  return c ? 'STILL_THERE' : 'GONE';
})()`);
const dirGone = await ev(`window.__TAURI_INTERNALS__.invoke('fs_read', { vault: ${JSON.stringify(V)}, rel: 'plugins/e2e-tmp/plugin.json' }).then(() => 'EXISTS').catch(() => 'DELETED')`);
console.log("[3] 卡片消失:", gone, "| 目录:", dirGone);
if (gone !== "GONE" || dirGone !== "DELETED") { console.log("FAIL: 卸载未生效"); process.exit(1); }

// 4. 断链提示：记录视图创建含不存在笔记链接的记录 → 链接标灰
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('记录')); if (b) b.click(); return !!b; })()`);
await sleep(1200);
const broken = await ev(`(async () => {
  // 直接调 records 数据层创建：走 UI 太绕，改为在记录编辑器粘贴含 [[不存在的笔记]] 的文本
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新建'));
  if (b) b.click();
  await new Promise(r => setTimeout(r, 600));
  const ta = document.querySelector('.record-content-input');
  if (!ta) return 'NO_TEXTAREA';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '链接到 [[不存在的笔记xyz]]');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 800));
  const link = document.querySelector('.record-links .note-link');
  return link ? JSON.stringify({ broken: link.classList.contains('broken'), text: link.textContent }) : 'NO_LINK';
})()`);
console.log("[4] 断链提示:", broken);

// 5. 错误收集
let errs = 0;
for (const e of events) {
  if (e.method === "Runtime.exceptionThrown") { errs++; console.log("[exception]", e.params.exceptionDetails.text); }
  if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
    const t = e.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { errs++; console.log("[console.error]", t); }
  }
}
console.log(`[5] 错误数: ${errs}`);
ws.close();
if (errs > 0) process.exit(1);
console.log("=== DONE ===");
process.exit(0);
