// cdp-overview-ui.mjs — 概览页动态插件概览 E2E：
// 概览页渲染已安装插件卡片（核心/外部，状态/版本）→ 点击卡片跳插件页
import { findMainPage, connect, sleep, helpers } from "./cdp-lib.mjs";
const page = await findMainPage("9226");
if (!page) {
  console.error("no main page");
  process.exit(1);
}
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);

await sleep(800);

// ---- 1. 进概览页 → 动态插件卡片出现 ----
await clickText(".nav-item", "概览");
await waitFor(`!!document.querySelector('.welcome .module-card')`, "插件卡片出现");
const cards = await ev(
  `[...document.querySelectorAll('.welcome .module-card')].map(c => c.textContent.replace(/\\s+/g, ' ').trim())`,
);
console.log("插件卡片:", cards.length, "张");
if (cards.length < 8) throw new Error(`插件卡片过少（应含 6 核心+外部）: ${cards.length}`);
if (!cards.some((c) => c.includes("笔记") && c.includes("核心")))
  throw new Error("笔记卡片应带「核心」标记");
if (!cards.some((c) => c.includes("已启用"))) throw new Error("应有「已启用」状态标签");
log(`PASS 概览页渲染 ${cards.length} 张插件卡片（核心/外部，含启用状态）`);

// ---- 2. 点击卡片 → 跳转插件页 ----
const clicked = await ev(`(() => {
  const card = [...document.querySelectorAll('.welcome .module-card')].find(c => c.textContent.includes('笔记'));
  if (!card) return false;
  card.click(); return true;
})()`);
if (!clicked) throw new Error("无法点击插件卡片");
await waitFor(`!!document.querySelector('.plugin-card')`, "插件页出现");
log("PASS 点击卡片 → 跳转插件页");

log("\n========== OVERVIEW_UI_E2E_PASS ==========");
process.exit(0);
