// cdp-records-ui.mjs — core-records 插件自带前端 E2E：挂载/列表/新建/编辑保存/删除
import { findMainPage, connect, sleep } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) { console.error("no main page"); process.exit(1); }
const { ev } = await connect(page);
const waitFor = async (expr, desc, timeoutMs = 30000, interval = 400) => {
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

await sleep(800);

// ---- 1. 记录视图渲染插件自带前端 ----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
await clickText(".nav-item", "记录");
await waitFor(`!!document.querySelector('.plugin-ui-view .records-view')`, "插件自带界面挂载");
const hostView = await ev(`!!document.querySelector('.records-view:not(.plugin-ui-view .records-view)')`);
if (hostView) throw new Error("宿主 RecordsView 与插件界面并存");
log("PASS 记录页渲染插件自带前端（core-records ui/index.js）");

// ---- 2. 列表经桥加载 ----
await waitFor(`document.querySelectorAll('.plugin-ui-view .record-row').length >= 1`, "记录列表出现");
const before = await ev(`document.querySelectorAll('.plugin-ui-view .record-row').length`);
log(`PASS 列表经桥加载（${before} 条）`);

// ---- 3. 新建记录 → 编辑器出现 ----
await clickText(".plugin-ui-view .records-pane-actions button", "新建");
await waitFor(`!!document.querySelector('.plugin-ui-view .record-editor')`, "记录编辑器出现");
await waitFor(`document.querySelectorAll('.plugin-ui-view .record-row').length === ${before + 1}`, "新记录行出现");
log("PASS 新建记录（records.create 经桥 + DLL）");

// ---- 4. 编辑标题 + 内容 → 防抖自动保存 ----
const newTitle = `E2E记录${Date.now().toString(36)}`;
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .record-title-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(newTitle)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .record-content-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, 'E2E 内容 ' + Date.now());
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(1800); // 800ms 防抖 + 落盘
const rowTitle = await ev(`[...document.querySelectorAll('.plugin-ui-view .record-row-title')].some(e => e.textContent === ${JSON.stringify(newTitle)})`);
if (!rowTitle) throw new Error(`编辑后的标题未出现在列表（records.save 未生效或未刷新）`);
log("PASS 编辑 → 防抖自动保存（records.save 经桥，列表刷新显示新标题）");

// ---- 5. 删除新建记录（确认对话框）----
await ev(`(() => {
  const row = [...document.querySelectorAll('.plugin-ui-view .record-row')].find(r => r.querySelector('.record-row-title')?.textContent === ${JSON.stringify(newTitle)});
  const b = row?.querySelector('.tree-action.danger');
  b?.click(); return !!b;
})()`);
await waitFor(`!!document.querySelector('.plugin-ui-view .confirm-overlay')`, "删除确认框出现");
await clickText(".plugin-ui-view .confirm-actions button", "删除");
await waitFor(`document.querySelectorAll('.plugin-ui-view .record-row').length === ${before}`, "记录已删除");
log("PASS 删除记录（确认对话框 → records.delete 经桥）");

log("\n========== RECORDS_UI_E2E_PASS ==========");
process.exit(0);
