// cdp-checklist-ui.mjs — core-checklists 插件自带前端 E2E：挂载/新建清单/条目打卡/删除
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

// ---- 1. 清单视图渲染插件自带前端 ----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
await clickText(".nav-item", "清单");
await waitFor(`!!document.querySelector('.plugin-ui-view .checklist-view')`, "插件自带界面挂载");
const hostView = await ev(`!!document.querySelector('.checklist-view:not(.plugin-ui-view .checklist-view)')`);
if (hostView) throw new Error("宿主 ChecklistView 与插件界面并存");
log("PASS 清单页渲染插件自带前端（core-checklists ui/index.js）");

// ---- 2. 既有清单列表加载 ----
await waitFor(`document.querySelectorAll('.plugin-ui-view .checklist-row').length >= 1`, "清单列表出现");
const before = await ev(`document.querySelectorAll('.plugin-ui-view .checklist-row').length`);
log(`PASS 列表经桥加载（${before} 个清单）`);

// ---- 3. 新建清单 ----
const listTitle = `E2E清单${Date.now().toString(36)}`;
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .checklist-new-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(listTitle)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await ev(`document.querySelector('.plugin-ui-view .checklist-new-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await waitFor(`document.querySelectorAll('.plugin-ui-view .checklist-row').length === ${before + 1}`, "新清单行出现");
await waitFor(`!!document.querySelector('.plugin-ui-view .checklist-editor')`, "清单编辑器打开");
log("PASS 新建清单（chk.create 经桥 + DLL 并自动打开）");

// ---- 4. 添加条目 + 打卡 ----
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .checklist-add input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'E2E 条目');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await ev(`document.querySelector('.plugin-ui-view .checklist-add input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await waitFor(`document.querySelectorAll('.plugin-ui-view .checklist-item').length >= 1`, "条目出现");
const progress = await ev(`document.querySelector('.plugin-ui-view .checklist-progress-text')?.textContent`);
await ev(`document.querySelector('.plugin-ui-view .checklist-item .checklist-check input')?.click()`);
await sleep(1200); // 防抖保存 + chk-changed 刷新
const done = await ev(`document.querySelectorAll('.plugin-ui-view .checklist-item.done').length`);
if (done < 1) throw new Error("打卡后条目未标记 done");
const progress2 = await ev(`document.querySelector('.plugin-ui-view .checklist-progress-text')?.textContent`);
log(`PASS 添加条目 + 打卡（进度 ${progress} → ${progress2}）`);

// ---- 5. 删除清单（确认对话框）----
await ev(`(() => {
  const row = [...document.querySelectorAll('.plugin-ui-view .checklist-row')].find(r => r.querySelector('.checklist-row-title')?.textContent === ${JSON.stringify(listTitle)});
  const b = row?.querySelector('.tree-action.danger');
  b?.click(); return !!b;
})()`);
await waitFor(`!!document.querySelector('.plugin-ui-view .confirm-overlay')`, "删除确认框出现");
await clickText(".plugin-ui-view .confirm-actions button", "删除");
await waitFor(`document.querySelectorAll('.plugin-ui-view .checklist-row').length === ${before}`, "清单已删除");
log("PASS 删除清单（确认对话框 → chk.delete 经桥）");

log("\n========== CHECKLIST_UI_E2E_PASS ==========");
process.exit(0);
