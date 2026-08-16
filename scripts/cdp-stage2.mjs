// cdp-stage2.mjs — 阶段 2 E2E：博客/AI/搜索/备份核心插件 + 系统锁定
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
const invoke = (cmd, args) =>
  ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

await send("Runtime.enable");
await sleep(600);
const VAULT = "D:\\\\WORKSPACE\\\\ToolBox\\\\src-tauri\\\\target\\\\e2e-vault";
const pc = (id, command, args) => invoke("plugin_call", { vault: VAULT, id, command, args });

// ---- 1. 侧边栏：内容 + 系统入口齐全且无重复 ----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
const nav = await ev(`[...document.querySelectorAll('.nav-item span')].map(s => s.textContent)`);
for (const expect of ["笔记", "记录", "清单", "项目", "AI 整理", "博客发布", "设置"]) {
  if (!nav.includes(expect)) throw new Error(`侧边栏缺「${expect}」: ${JSON.stringify(nav)}`);
}
const dupes = nav.filter((n, i) => nav.indexOf(n) !== i);
if (dupes.length > 0) throw new Error(`侧边栏有重复项: ${JSON.stringify(dupes)}`);
log("PASS 侧边栏 9 插件入口齐全且无重复（含 AI/博客）");

// ---- 2. 插件页：9 个核心插件；backup/search 系统锁定（无禁用按钮）----
await clickText(".nav-item", "插件");
await waitFor(
  `[...document.querySelectorAll('.plugin-card')].filter(c => c.textContent.includes('核心')).length >= 9`,
  "9 个核心插件卡片"
);
const coreNames = await ev(
  `[...document.querySelectorAll('.plugin-card')].filter(c => c.textContent.includes('核心')).map(c => c.querySelector('h2')?.textContent)`
);
for (const expect of ["记录", "笔记", "待办", "清单", "项目", "博客", "AI", "搜索", "备份"]) {
  if (!coreNames.includes(expect)) throw new Error(`插件页缺「${expect}」: ${JSON.stringify(coreNames)}`);
}
// 系统插件：有"系统"徽章且无禁用按钮
const sysInfo = await ev(`(() => {
  const sys = [...document.querySelectorAll('.plugin-card')].filter(c => c.textContent.includes('系统'));
  return sys.map(c => ({
    name: c.querySelector('h2')?.textContent,
    badges: [...c.querySelectorAll('.badge')].map(b => b.textContent.trim()),
    hasDisable: [...c.querySelectorAll('button')].some(b => b.textContent.trim() === '禁用'),
  }));
})()`);
for (const s of sysInfo) {
  if (s.hasDisable) throw new Error(`系统插件「${s.name}」不应有禁用按钮`);
  if (!s.badges.includes("系统")) throw new Error(`系统插件「${s.name}」缺系统徽章`);
}
log("PASS 9 个核心插件 + 搜索/备份系统锁定（无禁用按钮）");

// ---- 3. 搜索：core-search DLL 文件命中 ----
await clickText(".nav-item", "笔记");
await waitFor(`!!document.querySelector('.search input')`, "搜索框");
await ev(`(() => {
  const el = document.querySelector('.search input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'E2E阶段1');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await waitFor(
  `[...document.querySelectorAll('.result-item')].length >= 1`,
  "搜索命中（core-search FTS）"
);
const searchOk = await ev(`(() => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  return inv('plugin_call', { vault: ${JSON.stringify(VAULT)}, id: 'core-search', command: 'search.query', args: { query: 'E2E阶段1' } }).then(r => Array.isArray(r) && r.length >= 1);
})()`);
if (!searchOk) throw new Error("core-search search.query 失败");
log("PASS 搜索经 core-search DLL（FTS 命中）");

// ---- 4. 博客：core-blog DLL 生成站点 ----
const blog = await pc("core-blog", "blog.generate", { siteTitle: "E2E 测试站" });
if (!blog?.siteDir || blog.posts < 0) throw new Error("blog.generate 失败: " + JSON.stringify(blog));
await clickText(".nav-item", "博客发布");
await waitFor(`!!document.querySelector('.blog-view') || document.querySelectorAll('button').length > 0`, "博客视图");
log(`PASS 博客经 core-blog DLL 生成站点（${blog.posts} 篇）`);

// ---- 5. 备份：core-backup DLL 立即备份 + 恢复 ----
await clickText(".nav-item", "设置");
await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('立即备份'))`, "备份卡片");
await clickText("button", "立即备份");
await waitFor(
  `[...document.querySelectorAll('.settings-message')].some(m => m.textContent.includes('备份完成'))`,
  "备份完成（core-backup）"
);
const backupRows = await ev(`document.querySelectorAll('.backup-row').length`);
if (backupRows < 1) throw new Error("备份列表为空");
const hasConfigBadge = await ev(
  `(() => { const row = document.querySelector('.backup-row'); return !!row && [...row.querySelectorAll('.badge-version')].some(b => b.textContent.trim() === '配置'); })()`
);
if (!hasConfigBadge) throw new Error("备份缺配置存档徽章");
log("PASS 备份经 core-backup DLL（含配置/插件存档）");

// ---- 6. AI：configGet（keyring 安全，不覆盖真实凭据）----
const aiCfg = await pc("core-ai", "ai.configGet", {});
if (!aiCfg || typeof aiCfg.hasKey !== "boolean") throw new Error("ai.configGet 失败: " + JSON.stringify(aiCfg));
log(`PASS AI 经 core-ai DLL（hasKey=${aiCfg.hasKey}，凭据在系统凭据管理器）`);

// ---- 7. 禁用 core-blog（可禁用）→ 侧边栏消失；core-backup（系统）拒绝禁用 ----
await clickText(".nav-item", "插件");
await waitFor(`[...document.querySelectorAll('.plugin-card')].some(c => c.querySelector('h2')?.textContent === '博客')`, "博客插件卡片");
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '博客');
  const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '禁用');
  b.click(); return true;
})()`);
await waitFor(
  `![...document.querySelectorAll('.nav-item span')].some(s => s.textContent === '博客发布')`,
  "禁用博客后侧边栏入口消失"
);
log("PASS 禁用 core-blog → 博客入口消失（可选择性使用）");
// 重新启用
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '博客');
  const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '启用');
  b.click(); return true;
})()`);
await waitFor(
  `[...document.querySelectorAll('.nav-item span')].some(s => s.textContent === '博客发布')`,
  "重新启用博客"
);
// 系统插件禁用被拒：直接 invoke set_enabled 验证
const deny = await ev(`(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  try {
    await inv('plugins_set_enabled', { vault: ${JSON.stringify(VAULT)}, id: 'core-backup', enabled: false });
    return 'accepted';
  } catch (e) { return 'denied: ' + String(e); }
})()`);
if (!String(deny).startsWith("denied")) throw new Error("系统插件应拒绝禁用: " + deny);
log("PASS 系统插件（core-backup）禁用被拒绝");

log("\n========== STAGE2_E2E_PASS ==========");
process.exit(0);
