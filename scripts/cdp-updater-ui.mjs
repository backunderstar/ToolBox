// cdp-updater-ui.mjs — 自动更新 UI E2E（B4）：
// 设置 → 关于 → 「检查更新」按钮可用，点击后进入检查态并给出结果
// （dev/占位 endpoint 下预期失败态：证明 前端 → updater 插件 IPC 通路正常）
import { findMainPage, connect, sleep, helpers } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) {
  console.error("no main page");
  process.exit(1);
}
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);

await sleep(800);

// ---- 1. 进入设置页 ----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
const navTexts = await ev(
  `[...document.querySelectorAll('.nav-item')].map(n => n.textContent)`,
);
if (!navTexts.some((t) => t.includes("设置"))) {
  console.error(`导航无「设置」项: ${JSON.stringify(navTexts)}`);
  process.exit(1);
}
await clickText(".nav-item", "设置");
await waitFor(`!!document.querySelector('.settings-card')`, "设置页渲染");
log("PASS 进入设置页");

// ---- 2. 关于卡片有「检查更新」按钮 ----
await waitFor(
  `[...document.querySelectorAll('.settings-card button')].some(b => b.textContent.includes('检查更新'))`,
  "关于卡片出现「检查更新」按钮",
);
log("PASS 关于卡片提供「检查更新」按钮");

// ---- 3. 点击 → 进入检查态 ----
await ev(
  `(() => { const b = [...document.querySelectorAll('.settings-card button')].find(b => b.textContent.includes('检查更新')); b?.click(); return !!b; })()`,
);
// 检查态（按钮变「检查中…」）可能出现得很快，允许直接落入结果态：
// 结果必须是「已是最新版本」或「检查失败」（本环境 endpoint 为占位 URL，预期失败态）
const settled = await waitFor(
  `(() => { const t = [...document.querySelectorAll('.settings-card .settings-value')].map(v => v.textContent).join(' '); return t.includes('已是最新版本') || t.includes('检查失败'); })()`,
  "更新检查给出结果（最新或失败）",
  30000,
).catch(() => false);
if (!settled) throw new Error("更新检查未在 30s 内给出结果（IPC 或插件异常）");
const result = await ev(
  `[...document.querySelectorAll('.settings-card .settings-value')].map(v => v.textContent).join(' ')`,
);
log(`PASS 更新检查给出结果: ${result.slice(0, 80)}`);

log("\n========== UPDATER_UI_E2E_PASS ==========");
process.exit(0);
