// cdp-runtime-regress.mjs — 统一运行时回归：webview 插件（text-stats）仍可用 + blog ui 仍工作
import { findMainPage, connect, sleep , helpers } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) { console.error("no main page"); process.exit(1); }
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);

await sleep(600);

// ---- 1. webview 插件（text-stats）经统一运行时加载：启用 → 就绪（命令注册成功）----
await clickText(".nav-item", "插件");
await waitFor(`[...document.querySelectorAll('.plugin-card')].some(c => c.textContent.includes('文本统计'))`, "text-stats 卡片");
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.textContent.includes('文本统计'));
  const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '启用');
  if (b) b.click();
  return true;
})()`);
await waitFor(
  `(() => { const c = [...document.querySelectorAll('.plugin-card')].find(x => x.textContent.includes('文本统计')); return c ? c.textContent.includes('就绪') : false; })()`,
  "text-stats 就绪（统一运行时加载成功）"
);
log("PASS webview 插件 text-stats 经统一运行时加载（命令注册成功）");

// ---- 2. 博客插件自带前端仍工作 ----
await clickText(".nav-item", "博客发布");
await waitFor(`!!document.querySelector('.blog-plugin-ui')`, "插件自带界面挂载");
await waitFor(`document.querySelectorAll('.blog-ui-row').length >= 1`, "列表经桥加载");
log("PASS 博客插件自带前端（统一桥）仍工作");

log("\n========== RUNTIME_REGRESS_PASS ==========");
process.exit(0);
