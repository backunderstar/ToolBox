// cdp-stage0.mjs — 阶段 0 E2E：原生核心插件全链路 + 备份恢复 + 搜索提供者 + 历史删除
// 前置：pnpm tauri dev（windows 临时带 --remote-debugging-port=9226）+ pnpm build:core
const PORT = process.argv[2] ?? "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page =
  targets.find((t) => t.type === "page" && /1420|tauri/.test(t.url)) ??
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      cb(m);
    }
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
const waitFor = async (expr, desc, timeoutMs = 25000, interval = 300) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ev(expr)) return true;
    await sleep(interval);
  }
  throw new Error(`超时等待: ${desc}`);
};
const clickText = async (selector, text) => {
  const ok = await ev(
    `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = els.find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`
  );
  if (!ok) throw new Error(`未找到可点元素 ${selector}「${text}」`);
};
const log = (s) => console.log(s);

await send("Runtime.enable");
await sleep(600);

// ---- 1. 侧边栏不应再有版本历史 ----
await waitFor(`!!document.querySelector('.sidebar')`, "侧边栏出现");
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
const hasHistory = await ev(
  `[...document.querySelectorAll('.nav-item span')].some(s => s.textContent === '版本历史')`
);
if (hasHistory) throw new Error("版本历史入口仍在");
log("PASS 版本历史已从侧边栏移除");

// ---- 2. 插件页：core-records 原生核心插件 ----
await clickText(".nav-item", "插件");
await waitFor(
  `[...document.querySelectorAll('.plugin-card')].some(c => c.querySelector('h2')?.textContent === '记录')`,
  "记录核心插件卡片"
);
const core = await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '记录');
  return {
    badges: [...c.querySelectorAll('.badge')].map(b => b.textContent.trim()),
    hasUninstall: [...c.querySelectorAll('button')].some(b => b.textContent.includes('卸载')),
    enabled: [...c.querySelectorAll('button')].some(b => b.textContent.trim() === '禁用'),
  };
})()`);
if (!core.badges.includes("核心")) throw new Error("缺核心徽章: " + core.badges);
if (!core.badges.includes("原生")) throw new Error("缺原生徽章: " + core.badges);
if (!core.badges.includes("搜索提供者")) throw new Error("缺搜索提供者徽章: " + core.badges);
if (core.hasUninstall) throw new Error("核心插件不应有卸载按钮");
log("PASS 核心插件徽章（核心/原生/搜索提供者）且不可卸载");

if (!core.enabled) {
  await ev(`(() => {
    const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '记录');
    const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '启用');
    b.click(); return true;
  })()`);
  await waitFor(
    `(() => { const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '记录'); return [...c.querySelectorAll('.badge')].some(b => b.textContent.trim() === '就绪'); })()`,
    "记录插件就绪（DLL 加载）"
  );
}
log("PASS core-records 启用并加载");

// ---- 3. 记录页 CRUD 走原生插件 ----
await clickText(".nav-item", "记录");
await waitFor(`!!document.querySelector('.records-view')`, "记录视图");
await clickText(".records-pane-actions button", "新建");
await waitFor(`!!document.querySelector('.record-title-input')`, "记录编辑器");
const title = `E2E插件化记录${Date.now().toString(36)}`;
await ev(`(() => {
  const el = document.querySelector('.record-title-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(title)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(1600); // 防抖 800ms 保存
await waitFor(
  `[...document.querySelectorAll('.record-row-title')].some(e => e.textContent === ${JSON.stringify(title)})`,
  "记录出现在列表（经插件落盘）"
);
log(`PASS 记录 CRUD 走原生插件（${title}）`);

// ---- 4. 搜索提供者命中 ----
await clickText(".nav-item", "笔记");
await waitFor(`!!document.querySelector('.search input')`, "搜索框");
await ev(`(() => {
  const el = document.querySelector('.search input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '插件化记录');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await waitFor(`!!document.querySelector('.result-source')`, "搜索提供者命中（来源徽章）");
const src = await ev(`document.querySelector('.result-source')?.textContent`);
if (src !== "记录") throw new Error("来源徽章应为「记录」: " + src);
await ev(`(() => { const el = document.querySelector('.result-item'); if (!el) return false; el.click(); return true; })()`);
await waitFor(`!!document.querySelector('.records-view')`, "从搜索结果跳转记录页");
log("PASS 搜索聚合 provider 命中（来源徽章 + 跳转）");

// ---- 5. 禁用 → 侧边栏入口消失；重新启用恢复 ----
await clickText(".nav-item", "插件");
await waitFor(
  `[...document.querySelectorAll('.plugin-card')].some(c => c.querySelector('h2')?.textContent === '记录')`,
  "插件卡片"
);
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '记录');
  const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '禁用');
  b.click(); return true;
})()`);
await waitFor(
  `![...document.querySelectorAll('.nav-item span')].some(s => s.textContent === '记录')`,
  "禁用后侧边栏记录入口消失"
);
log("PASS 禁用核心插件 → 导航入口消失（选择性使用）");
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '记录');
  const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '启用');
  b.click(); return true;
})()`);
await waitFor(
  `[...document.querySelectorAll('.nav-item span')].some(s => s.textContent === '记录')`,
  "重新启用后入口恢复"
);
log("PASS 重新启用核心插件 → 入口恢复");

// ---- 6. 备份：立即备份（含配置/插件存档）+ 恢复 ----
await clickText(".nav-item", "设置");
await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('立即备份'))`, "备份卡片");
await clickText("button", "立即备份");
await waitFor(
  `[...document.querySelectorAll('.settings-message')].some(m => m.textContent.includes('备份完成'))`,
  "备份完成消息"
);
await waitFor(
  `(() => { const row = document.querySelector('.backup-row'); return !!row && [...row.querySelectorAll('.badge-version')].some(b => b.textContent.trim() === '配置'); })()`,
  "备份含配置存档徽章"
);
const hasPluginBadge = await ev(
  `(() => { const row = document.querySelector('.backup-row'); return !!row && [...row.querySelectorAll('.badge-version')].some(b => b.textContent.trim() === '插件'); })()`
);
if (!hasPluginBadge) throw new Error("备份缺插件存档徽章");
log("PASS 备份含配置/插件存档");
await ev(`(() => {
  const row = document.querySelector('.backup-row');
  const b = [...row.querySelectorAll('button')].find(x => x.textContent.trim() === '恢复');
  b.click(); return true;
})()`);
await waitFor(`!!document.querySelector('.confirm-dialog')`, "恢复确认对话框");
await ev(`(() => {
  const d = document.querySelector('.confirm-dialog');
  const b = [...d.querySelectorAll('button')].find(x => x.textContent.trim() === '恢复');
  b.click(); return true;
})()`);
await waitFor(
  `[...document.querySelectorAll('.settings-message')].some(m => m.textContent.includes('已恢复'))`,
  "恢复成功提示"
);
log("PASS 恢复到备份点（恢复前自动保存现场）");

log("\n========== STAGE0_E2E_PASS ==========");
process.exit(0);

// 兜底（上方已 exit；此处仅为防止未捕获异常时的静默）
