// cdp-plugin-ui.mjs — 插件自带前端（组件模式）E2E：core-blog ui/index.js 加载 + 功能
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

// ---- 1. 侧边栏 → 博客发布（core-blog 自带前端渲染）----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
await clickText(".nav-item", "博客发布");
await waitFor(`!!document.querySelector('.blog-plugin-ui')`, "插件自带界面挂载（非宿主 BlogView）");
const hasHostView = await ev(`!!document.querySelector('.blog-view')`);
if (hasHostView) throw new Error("仍渲染宿主 BlogView（应渲染插件自带界面）");
log("PASS 博客页渲染插件自带前端（core-blog ui/index.js）");

// ---- 2. 列表：经桥调用 core-blog DLL 拉取笔记 ----
await waitFor(`document.querySelectorAll('.blog-ui-row').length >= 1`, "笔记列表出现（经桥 → DLL）");
const rowInfo = await ev(`(() => {
  const rows = [...document.querySelectorAll('.blog-ui-row')];
  return rows.map(r => ({
    title: r.querySelector('.blog-ui-title')?.textContent,
    meta: r.querySelector('.blog-ui-meta')?.textContent,
  }));
})()`);
log(`PASS 列表经桥加载（${rowInfo.length} 条，如「${rowInfo[0]?.title}」）`);

// ---- 3. 生成站点（插件页面按钮 → 桥 → blog.generate）----
const inputSet = await ev(`(() => {
  const el = document.querySelector('.blog-plugin-ui .settings-input');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'E2E 插件界面站');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
if (!inputSet) throw new Error("未找到站点标题输入框");
await sleep(200);
await clickText(".blog-plugin-ui button", "生成站点");
await waitFor(
  `[...document.querySelectorAll('.blog-plugin-ui .settings-message')].some(m => m.textContent.includes('站点已生成'))`,
  "生成站点成功提示（经桥）"
);
log("PASS 生成站点经插件界面按钮 + 桥 + DLL");

// ---- 4. 发布状态切换（桥跨插件调用 core-notes 读写；选有 status 的已发布笔记）----
const firstTitle = await ev(`document.querySelector('.blog-ui-row .blog-ui-title')?.textContent`);
const toggled = await ev(`(() => {
  const rows = [...document.querySelectorAll('.blog-ui-row')];
  const row = rows.find(r => r.textContent.includes('已发布'));
  if (!row) return 'no published row';
  const b = [...row.querySelectorAll('button')].find(x => x.textContent.trim() === '撤回草稿');
  if (!b) return 'no revoke btn';
  b.click(); return 'clicked';
})()`);
if (toggled !== "clicked") throw new Error("未找到已发布笔记行: " + toggled);
await waitFor(
  `[...document.querySelectorAll('.blog-plugin-ui .settings-message')].some(m => m.textContent.includes('已撤回'))`,
  "发布状态切换（经桥跨插件调用）"
);
log(`PASS 发布状态切换（${firstTitle}）`);

log("\n========== PLUGIN_UI_E2E_PASS ==========");
process.exit(0);
