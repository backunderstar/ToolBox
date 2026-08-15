// 第二批 E2E：插件状态迁移/ConfirmDialog/回收站删除/主题导入导出/浮窗记忆。
// 用法: node scripts/cdp-batch2.mjs [port]
const PORT = process.argv[2] ?? "9226";
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

// 1. 插件页：启用状态应从 vault 旧文件迁移（文本统计就绪）
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('插件')); if (b) b.click(); return !!b; })()`);
await sleep(1500);
const pluginState = await ev(`JSON.stringify([...document.querySelectorAll('.plugin-card')].map(c => ({
  name: (c.querySelector('.plugin-title h2')||{}).textContent,
  status: (c.querySelector('.badge-status')||{}).textContent,
})))`);
console.log("[1] 插件状态(应含迁移后的就绪):", pluginState);

// 2. 清单页 ConfirmDialog：先建清单 → 点删除 → 弹窗出现 → 取消/确认
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('清单')); if (b) b.click(); return !!b; })()`);
await sleep(1200);
await ev(`(async () => {
  const input = document.querySelector('.checklist-new-input');
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'E2E 确认清单');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 800));
  return true;
})()`);
const confirmBefore = await ev(`(() => {
  const btns = [...document.querySelectorAll('.checklist-row-actions button')];
  const del = btns[0];
  if (del) del.click();
  return !!del;
})()`);
await sleep(500);
const dialogShown = await ev(`(() => {
  const d = document.querySelector('.confirm-dialog');
  return d ? JSON.stringify({ title: d.querySelector('.confirm-title')?.textContent }) : null;
})()`);
console.log("[2] ConfirmDialog 弹出:", dialogShown);
if (!dialogShown) { console.log("FAIL: 应弹出确认对话框"); process.exit(1); }
// 确认删除（验证 dialog 按钮工作 + 删除生效）
await ev(`(() => { const d = document.querySelector('.confirm-dialog'); if (d) { const b = [...d.querySelectorAll('button')].find(x => x.textContent === '删除'); b?.click(); } return true; })()`);
await sleep(800);
const afterConfirm = await ev(`(() => ({
  dialogGone: !document.querySelector('.confirm-dialog'),
  rows: document.querySelectorAll('.checklist-row').length,
}))()`);
console.log("[3] 确认后:", JSON.stringify(afterConfirm));
if (!afterConfirm.dialogGone) { console.log("FAIL: 确认后对话框应关闭"); process.exit(1); }

// 3. 笔记删除进回收站：新建临时笔记 → 删除 → 无错误
const trashTest = await ev(`(async () => {
  const V = 'D:\\\\WORKSPACE\\\\ToolBox\\\\src-tauri\\\\target\\\\e2e-vault';
  const rel = 'notes/回收站测试.md';
  await window.__TAURI_INTERNALS__.invoke('fs_write', { vault: V, rel, content: '# 临时内容' });
  const del = await window.__TAURI_INTERNALS__.invoke('fs_delete', { vault: V, rel }).then(() => 'OK').catch(e => 'ERR:' + e);
  const exists = await window.__TAURI_INTERNALS__.invoke('fs_read', { vault: V, rel }).then(() => true).catch(() => false);
  return JSON.stringify({ del, stillExists: exists });
})()`);
console.log("[4] 回收站删除(应 OK 且不存在):", trashTest);

// 4. 主题导出/导入：设置页打开面板
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('设置')); if (b) b.click(); return !!b; })()`);
await sleep(1200);
const themeIo = await ev(`(() => {
  const btn = [...document.querySelectorAll('.theme-actions button')].find(x => x.textContent.includes('导出'));
  if (btn) btn.click();
  return !!btn;
})()`);
await sleep(500);
const ioPanel = await ev(`(() => {
  const ta = document.querySelector('.theme-io-textarea');
  return ta ? ta.getAttribute('readonly') !== null ? 'export-mode' : 'import-mode' : null;
})()`);
console.log("[5] 主题导出面板:", themeIo ? ioPanel : "NO_BTN");

// 5. 错误收集
let errs = 0;
for (const e of events) {
  if (e.method === "Runtime.exceptionThrown") { errs++; console.log("[exception]", e.params.exceptionDetails.text); }
  if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
    const t = e.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { errs++; console.log("[console.error]", t); }
  }
}
console.log(`[6] 错误数: ${errs}`);
ws.close();
if (!dialogShown || !afterConfirm.dialogGone) process.exit(1);
if (errs > 0) process.exit(1);
console.log("=== DONE ===");
process.exit(0);
