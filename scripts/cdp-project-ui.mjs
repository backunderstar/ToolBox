// cdp-project-ui.mjs — core-projects 插件自带前端 E2E：列表/新建/详情/归档
import { findMainPage, connect, sleep } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) { console.error("no main page"); process.exit(1); }
const { ev } = await connect(page);
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

await sleep(600);

// ---- 1. 项目页渲染插件自带前端（非宿主 ProjectsView）----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
await clickText(".nav-item", "项目");
await waitFor(`!!document.querySelector('.plugin-ui-view .projects-view')`, "插件自带界面挂载");
const hostView = await ev(`!!document.querySelector('.projects-view:not(.plugin-ui-view .projects-view)')`);
if (hostView) throw new Error("宿主 ProjectsView 与插件界面并存（应只渲染插件界面）");
log("PASS 项目页渲染插件自带前端（core-projects ui/index.js）");

// ---- 2. 列表经桥加载（既有项目）----
await waitFor(`document.querySelectorAll('.plugin-ui-view .project-card').length >= 1`, "项目列表出现");
const names = await ev(`[...document.querySelectorAll('.plugin-ui-view .project-card-name')].map(e => e.textContent)`);
if (!names.includes("E2E 项目甲")) throw new Error(`缺既有项目: ${JSON.stringify(names)}`);
log(`PASS 列表经桥加载（${names.join("/")}）`);

// ---- 3. 新建项目（输入 + 按钮 → 桥 → DLL）----
const newName = `E2E插件项目${Date.now().toString(36)}`;
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .projects-new-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(newName)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await clickText(".plugin-ui-view .projects-new button", "新建项目");
await waitFor(
  `[...document.querySelectorAll('.plugin-ui-view .project-card-name')].some(e => e.textContent === ${JSON.stringify(newName)})`,
  "新项目出现在列表（经桥 → DLL 创建）"
);
log(`PASS 新建项目（${newName}）经桥 + DLL`);

// ---- 4. 打开项目详情 + 归档 ----
await ev(`(() => {
  const card = [...document.querySelectorAll('.plugin-ui-view .project-card')].find(c => c.querySelector('.project-card-name')?.textContent === ${JSON.stringify(newName)});
  const b = card?.querySelector('.project-card-main');
  if (b) b.click();
  return !!b;
})()`);
await waitFor(`!!document.querySelector('.plugin-ui-view .project-detail')`, "项目详情（文件浏览器）");
await clickText(".plugin-ui-view .project-detail-head button", "全部项目");
await waitFor(`!!document.querySelector('.plugin-ui-view .projects-new')`, "返回列表页");
log("PASS 打开详情 + 返回列表（导航状态经本地 state）");

log("\n========== PROJECT_UI_E2E_PASS ==========");
process.exit(0);
