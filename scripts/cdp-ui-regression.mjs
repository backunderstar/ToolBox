// UI 批次回归：主题热切换（Vditor 不重建）+ 键盘导航 + 常规冒烟。
// 用法: node scripts/cdp-ui-regression.mjs [port]
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

// 1. 进入笔记并打开一篇
await ev(`(() => { const b = document.querySelector('.welcome .btn-primary'); if (b) b.click(); return !!b; })()`);
await sleep(2200);
const opened = await ev(`(() => {
  const rows = [...document.querySelectorAll('.tree-row')];
  const note = rows.find(r => r.textContent.trim().endsWith('.md'));
  if (note) { note.click(); return true; }
  return false;
})()`);
console.log("[1] 打开笔记:", opened);
await sleep(2500);

// 2. 记录当前主题（用于断言切换生效）
const before = await ev(`(() => ({
  vd: !!document.querySelector('.vditor'),
  ir: !!document.querySelector('.vditor-ir'),
  theme: document.documentElement.dataset.theme ?? 'unknown',
}))()`);
console.log("[2] 编辑器状态:", JSON.stringify(before));

// 3. 切换主题（顶栏按钮，aria-label="切换主题"）→ Vditor 不应重建
const t0 = await ev(`(() => {
  const btn = document.querySelector('header button[aria-label="切换主题"]');
  if (btn) btn.click();
  return !!btn;
})()`);
console.log("[3] 点击主题切换:", t0);
await sleep(1200);
const after = await ev(`(() => ({
  vd: !!document.querySelector('.vditor'),
  ir: !!document.querySelector('.vditor-ir'),
  theme: document.documentElement.dataset.theme ?? 'unknown',
}))()`);
console.log("[4] 切换后:", JSON.stringify(after));

// 4. 再切回（验证往返都正常）
await ev(`(() => { const btn = document.querySelector('header button[aria-label="切换主题"]'); if (btn) btn.click(); return !!btn; })()`);
await sleep(800);

// 5. 键盘导航：文件树方向键（焦点在树行上按 ArrowDown）
const kb = await ev(`(() => {
  const rows = [...document.querySelectorAll('.tree-row')];
  if (rows.length < 2) return 'NOT_ENOUGH_ROWS';
  rows[0].focus();
  const evt = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  rows[0].dispatchEvent(evt);
  const focused = document.activeElement;
  return JSON.stringify({
    moved: focused !== rows[0],
    focusPath: focused?.getAttribute('data-path') ?? null,
  });
})()`);
console.log("[5] 文件树键盘导航:", kb);

// 6. 错误收集
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
if (!after.vd || !after.ir) { console.log("FAIL: 切换主题后编辑器应仍在"); process.exit(1); }
if (errs > 0) process.exit(1);
console.log("=== DONE ===");
process.exit(0);
