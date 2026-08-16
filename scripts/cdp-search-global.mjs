// cdp-search-global.mjs — 全局搜索 E2E（用户决策）：
// 1) 顶栏搜索恢复可用 → 输入触发全局 FTS（vault 根所有 .md）
// 2) 结果下拉出现，含 FTS 命中与 py-tools 搜索提供者命中（source 徽章，文件名匹配）
// 3) 点击结果 → 打开文件（笔记视图）
import { findMainPage, connect, sleep , helpers } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) { console.error("no main page"); process.exit(1); }
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);

await sleep(800);
// 搜索词 = 文件名片段：FTS（文件名/内容）与 py-tools provider（文件名匹配）都能命中
const TOKEN = "e2e-gsearch";
const NAME = `e2e-gsearch-${Date.now()}.md`;

// ---- 0. 确保工作区 + 写入测试文件（vault 根下任意位置，验证全局索引） ----
const vp = await ev(`(async () => { const inv = window.__TAURI_INTERNALS__.invoke; const s = await inv('vault_get'); return s.path || ''; })()`);
if (!vp) throw new Error("E2E 需先有工作区（前序套件应已设置）");
const wrote = await ev(`(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  try {
    await inv('plugin_call', { vault: ${JSON.stringify(vp)}, id: 'core-notes', command: 'notes.write', args: { rel: 'projects/${NAME}', content: '${TOKEN} 独特内容在这里。\\n' } });
    return 'ok';
  } catch (e) { return 'ERR:' + String(e); }
})()`);
if (!wrote.startsWith("ok")) throw new Error(`写入测试文件失败: ${wrote}`);
log("PASS 写入 vault/projects/ 下测试文件（验证全局索引范围）");

// ---- 1. 顶栏搜索框恢复可用 ----
const enabled = await ev(`(() => { const input = document.querySelector('.search input'); return input ? !input.disabled : false; })()`);
if (!enabled) throw new Error("顶栏搜索框应可用（全局搜索恢复）");
log("PASS 顶栏搜索框可用（全局搜索恢复）");

// ---- 2. 输入 → 下拉出现命中（FTS） ----
const typed = await ev(`(() => { const input = document.querySelector('.search input'); if (!input) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(TOKEN)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
if (!typed) throw new Error("无法输入搜索词");
await waitFor(`document.querySelectorAll('.search-dropdown .search-item').length >= 1`, "搜索结果下拉出现");
const ftsHit = await ev(`[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('${NAME}'))`);
if (!ftsHit) throw new Error(`FTS 应命中 ${NAME}（全局索引）`);
log("PASS 全局 FTS 命中 vault/projects/ 下的 md（不只 notes/）");

// ---- 3. 搜索提供者（py-tools）命中：source 徽章 ----
const providerHit = await ev(`[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('${NAME}') && i.textContent.includes('py-tools'))`);
if (!providerHit) throw new Error("py-tools 搜索提供者应命中（文件名匹配 + source 徽章）");
log("PASS py-tools searchProvider 聚合命中（source 徽章）");

// ---- 4. 点击结果 → 打开文件（笔记视图） ----
const clicked = await ev(`(() => { const item = [...document.querySelectorAll('.search-dropdown .search-item')].find(i => i.textContent.includes('${NAME}')); if (!item) return false; item.click(); return true; })()`);
if (!clicked) throw new Error("无法点击搜索结果");
await waitFor(`document.querySelector('.plugin-ui-view .vditor') !== null || document.body.textContent.includes('${TOKEN}')`, "笔记视图打开目标文件", 20000);
log("PASS 点击搜索结果 → 笔记视图打开目标文件");

log("\n========== SEARCH_GLOBAL_E2E_PASS ==========");
process.exit(0);
