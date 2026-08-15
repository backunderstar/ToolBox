// 导航栏可配置 E2E：顺序移动 / 隐藏 / 侧栏联动 / 持久化。
// 用法: node scripts/cdp-nav-config.mjs [port]
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri\.localhost/.test(t.url)) ?? targets.find((t) => t.type === "page");
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
  if (r.result?.exceptionDetails) return "EVAL_ERR:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1500));

// 清理旧配置，确保从默认开始
await ev(`localStorage.removeItem('toolbox.nav')`);
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 3000));

const sidebarOrder = async () =>
  ev(`JSON.stringify([...document.querySelectorAll('.sidebar .nav-item span')].map(s => s.textContent))`);

// 1. 初始侧栏顺序
console.log("[1] 初始侧栏:", await sidebarOrder());

// 2. 进入设置 → 找到导航栏卡片
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('设置')); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1200));
const card = await ev(`(() => {
  const cards = [...document.querySelectorAll('.settings-card')];
  const c = cards.find(x => (x.querySelector('.settings-title') ?? {}).textContent === '导航栏');
  return c ? JSON.stringify({
    rows: [...c.querySelectorAll('.nav-settings-row')].map(r => ({
      name: (r.querySelector('.nav-settings-name')?.textContent ?? '').trim(),
      checked: !!r.querySelector('input[type=checkbox]')?.checked,
    })),
    groups: [...c.querySelectorAll('.nav-settings-group-label')].map(g => g.textContent),
  }) : 'NO_CARD';
})()`);
console.log("[2] 导航栏卡片:", card);

// 3. 把"笔记"下移一位（工作区组：概览/笔记/插件/... → 笔记后移）
await ev(`(() => {
  const cards = [...document.querySelectorAll('.settings-card')];
  const c = cards.find(x => (x.querySelector('.settings-title') ?? {}).textContent === '导航栏');
  const rows = [...c.querySelectorAll('.nav-settings-row')];
  const notes = rows.find(r => (r.querySelector('.nav-settings-name')?.textContent ?? '').includes('笔记'));
  const btns = notes.querySelectorAll('button');
  btns[1].click(); // 下移
  return true;
})()`);
await new Promise((r) => setTimeout(r, 600));

// 4. 侧栏顺序应变化（概览/插件/笔记/...）
const after = JSON.parse(await sidebarOrder());
console.log("[3] 下移'笔记'后侧栏:", JSON.stringify(after));
const idxNotes = after.indexOf("笔记");
const idxPlugins = after.indexOf("插件");
if (!(idxNotes > idxPlugins)) { console.log("FAIL: 笔记应在插件之后"); process.exit(1); }

// 5. 隐藏"博客发布"
await ev(`(() => {
  const cards = [...document.querySelectorAll('.settings-card')];
  const c = cards.find(x => (x.querySelector('.settings-title') ?? {}).textContent === '导航栏');
  const rows = [...c.querySelectorAll('.nav-settings-row')];
  const blog = rows.find(r => (r.querySelector('.nav-settings-name')?.textContent ?? '').includes('博客'));
  blog.querySelector('input[type=checkbox]').click();
  return true;
})()`);
await new Promise((r) => setTimeout(r, 600));
const afterHide = JSON.parse(await sidebarOrder());
console.log("[4] 隐藏'博客'后侧栏:", JSON.stringify(afterHide));
if (afterHide.includes("博客发布")) { console.log("FAIL: 博客应被隐藏"); process.exit(1); }

// 6. 隐藏的"设置"开关应禁用
const settingsDisabled = await ev(`(() => {
  const cards = [...document.querySelectorAll('.settings-card')];
  const c = cards.find(x => (x.querySelector('.settings-title') ?? {}).textContent === '导航栏');
  const rows = [...c.querySelectorAll('.nav-settings-row')];
  const s = rows.find(r => (r.querySelector('.nav-settings-name')?.textContent ?? '').includes('设置'));
  return !!s.querySelector('input[type=checkbox]')?.disabled;
})()`);
console.log("[5] 设置的开关禁用:", settingsDisabled);
if (!settingsDisabled) { console.log("FAIL: 设置的开关应禁用"); process.exit(1); }

// 7. 持久化：刷新后顺序与隐藏保留
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 3000));
const persisted = JSON.parse(await sidebarOrder());
console.log("[6] 刷新后侧栏:", JSON.stringify(persisted));
if (JSON.stringify(persisted) !== JSON.stringify(afterHide)) { console.log("FAIL: 刷新后应保留配置"); process.exit(1); }

// 8. 恢复默认
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('设置')); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1200));
await ev(`(() => {
  const cards = [...document.querySelectorAll('.settings-card')];
  const c = cards.find(x => (x.querySelector('.settings-title') ?? {}).textContent === '导航栏');
  const btn = [...c.querySelectorAll('button')].find(b => b.textContent.includes('恢复默认'));
  if (btn) btn.click();
  return !!btn;
})()`);
await new Promise((r) => setTimeout(r, 600));
const restored = JSON.parse(await sidebarOrder());
console.log("[7] 恢复默认后:", JSON.stringify(restored));
// 断言用 indexOf（侧栏 DOM 里每项还含"就绪" badge span）
const ri = (id) => restored.indexOf(id);
if (!(ri("概览") < ri("笔记") && ri("笔记") < ri("插件") && restored.includes("博客发布"))) {
  console.log("FAIL: 应恢复默认顺序且博客可见");
  process.exit(1);
}

// 清理：恢复默认已做（第 7 步），无需额外
console.log("=== DONE ===");
ws.close();
process.exit(0);
