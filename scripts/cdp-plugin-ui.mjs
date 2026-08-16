// cdp-plugin-ui.mjs — 插件自带前端（组件模式）E2E：core-blog ui/index.js 加载 + 功能
import { findMainPage, connect, sleep, helpers } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) {
  console.error("no main page");
  process.exit(1);
}
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);

await sleep(600);

// ---- 1. 侧边栏 → 博客发布（core-blog 自带前端渲染）----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
await clickText(".nav-item", "博客发布");
await waitFor(`!!document.querySelector('.blog-plugin-ui')`, "插件自带界面挂载（非宿主 BlogView）");
const hasHostView = await ev(`!!document.querySelector('.blog-view')`);
if (hasHostView) throw new Error("仍渲染宿主 BlogView（应渲染插件自带界面）");
log("PASS 博客页渲染插件自带前端（core-blog ui/index.js）");

// ---- 2. 列表：经桥调用 core-blog DLL 拉取笔记 ----
await waitFor(
  `document.querySelectorAll('.blog-ui-row').length >= 1`,
  "笔记列表出现（经桥 → DLL）",
);
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
  "生成站点成功提示（经桥）",
);
log("PASS 生成站点经插件界面按钮 + 桥 + DLL");

// ---- 4. 发布状态切换（桥跨插件调用 core-notes 读写）----
// 夹具自适应：若当前没有"已发布"笔记（此前测试已全部撤回），先发布一篇再撤回
let toggled = await ev(`(() => {
  const rows = [...document.querySelectorAll('.blog-ui-row')];
  const row = rows.find(r => r.textContent.includes('已发布'));
  if (!row) return 'no published row';
  const b = [...row.querySelectorAll('button')].find(x => x.textContent.trim() === '撤回草稿');
  if (!b) return 'no revoke btn';
  b.click(); return 'clicked';
})()`);
if (toggled !== "clicked") {
  const published = await ev(`(() => {
    const rows = [...document.querySelectorAll('.blog-ui-row')];
    const row = rows.find(r => r.textContent.includes('草稿'));
    const b = row && [...row.querySelectorAll('button')].find(x => x.textContent.trim() === '发布');
    if (!b) return false;
    b.click(); return true;
  })()`);
  if (!published) throw new Error("无可发布的草稿笔记行");
  await waitFor(
    `[...document.querySelectorAll('.blog-ui-row')].some(r => r.textContent.includes('已发布'))`,
    "发布成功（经桥跨插件调用）",
  );
  // 发布后再撤回（幂等验证双向切换）
  toggled = await ev(`(() => {
    const rows = [...document.querySelectorAll('.blog-ui-row')];
    const row = rows.find(r => r.textContent.includes('已发布'));
    const b = row && [...row.querySelectorAll('button')].find(x => x.textContent.trim() === '撤回草稿');
    if (!b) return 'no revoke btn';
    b.click(); return 'clicked';
  })()`);
  if (toggled !== "clicked") throw new Error("发布后找不到撤回按钮: " + toggled);
}
await waitFor(
  `[...document.querySelectorAll('.blog-plugin-ui .settings-message')].some(m => m.textContent.includes('已撤回'))`,
  "发布状态切换（经桥跨插件调用）",
);
log("PASS 发布状态切换（发布 ↔ 撤回，桥跨插件调用 core-notes 读写）");

log("\n========== PLUGIN_UI_E2E_PASS ==========");
process.exit(0);
