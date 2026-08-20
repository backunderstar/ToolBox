// cdp-search-global.mjs — 全局搜索 E2E（用户决策）：
// 1) 顶栏搜索恢复可用 → 输入触发全局 FTS（vault 根所有 .md）
// 2) 结果下拉出现，含 FTS 命中与 py-tools 搜索提供者命中（source 徽章，文件名匹配）
// 3) 拼音搜索（首字母/全拼）命中中文文件名（用户优化项 C9）
// 4) 清单/待办数据内容命中（用户优化项 C9）
// 5) 点击结果 → 打开文件（笔记视图）
import { findMainPage, connect, sleep, helpers } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) {
  console.error("no main page");
  process.exit(1);
}
const { ev } = await connect(page);
const { waitFor, log } = helpers(ev);

await sleep(800);
// 搜索词 = 文件名片段：FTS（文件名/内容）与 py-tools provider（文件名匹配）都能命中
const TOKEN = "e2e-gsearch";
const NAME = `e2e-gsearch-${Date.now()}.md`;

// ---- 0. 清理历史测试文件（多次运行会累积 20+ 个 e2e-gsearch 文件，
//      挤掉最新文件的 FTS/provider 命中导致断言失败）+ 确保工作区 ----
import { globSync } from "node:fs";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// 仓库根由脚本位置推导（不硬编码绝对路径，换目录/换机器可移植）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VAULT = path.join(ROOT, "src-tauri", "target", "e2e-vault");
for (const f of globSync(`${VAULT}/projects/e2e-gsearch-*.md`)) rmSync(f, { force: true });
for (const f of globSync(`${VAULT}/projects/e2e-项目计划-*.md`)) rmSync(f, { force: true });
for (const f of globSync(`${VAULT}/data/checklists/e2e-clist-*.json`)) rmSync(f, { force: true });
const vp = await ev(
  `(async () => { const inv = window.__TAURI_INTERNALS__.invoke; const s = await inv('vault_get'); return s.path || ''; })()`,
);
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

// 搜索框输入辅助：先清空再输入（相同词 React state bail out 不触发重搜）
const typeSearch = (word) =>
  ev(`(() => {
    const input = document.querySelector('.search input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
    .then(() => sleep(250))
    .then(() =>
      ev(`(() => {
        const input = document.querySelector('.search input');
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(word)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`),
    );

// ---- 1. 顶栏搜索框恢复可用 ----
const enabled = await ev(
  `(() => { const input = document.querySelector('.search input'); return input ? !input.disabled : false; })()`,
);
if (!enabled) throw new Error("顶栏搜索框应可用（全局搜索恢复）");
log("PASS 顶栏搜索框可用（全局搜索恢复）");

// ---- 2. 输入 → 下拉出现命中（FTS）----
// 注意：① 搜索期间 results 保留旧值（防闪烁），需等**含目标文件**的 item
await typeSearch(TOKEN);
await waitFor(
  `[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('${NAME}'))`,
  "搜索结果下拉出现（含目标文件）",
  20000,
);
const ftsHit = await ev(
  `[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('${NAME}'))`,
);
if (!ftsHit) throw new Error(`FTS 应命中 ${NAME}（全局索引）`);
log("PASS 全局 FTS 命中 vault/projects/ 下的 md（不只 notes/）");

// ---- 3. 搜索提供者（py-tools）命中：source 徽章（且不包含 .toolbox 备份副本噪音）----
const providerHit = await ev(
  `[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('${NAME}') && i.textContent.includes('py-tools'))`,
);
if (!providerHit) throw new Error("py-tools 搜索提供者应命中（文件名匹配 + source 徽章）");
log("PASS py-tools searchProvider 聚合命中（source 徽章）");
const noBackupNoise = await ev(
  `![...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('.toolbox'))`,
);
if (!noBackupNoise) throw new Error("搜索结果不应包含 .toolbox 备份副本（提供者排除规则）");
log("PASS 搜索结果无 .toolbox 备份副本噪音");

// ---- 3b. 拼音搜索（用户优化项 C9）：首字母 "xmjh" + 全拼 "xiangmujihua" 命中中文文件名 ----
const CN_NAME = `e2e-项目计划-${Date.now()}.md`;
const cnWrote = await ev(`(async () => {
  const inv = window.__TAURI_INTERNALS__.invoke;
  try {
    await inv('plugin_call', { vault: ${JSON.stringify(vp)}, id: 'core-notes', command: 'notes.write', args: { rel: 'projects/${CN_NAME}', content: '拼音搜索测试内容。\\n' } });
    return 'ok';
  } catch (e) { return 'ERR:' + String(e); }
})()`);
if (!cnWrote.startsWith("ok")) throw new Error(`写入中文名文件失败: ${cnWrote}`);
await typeSearch("xmjh");
await waitFor(
  `[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('${CN_NAME}'))`,
  "拼音首字母 xmjh 命中中文文件名",
  20000,
);
const pinyinKind = await ev(
  `(() => { const item = [...document.querySelectorAll('.search-dropdown .search-item')].find(i => i.textContent.includes('${CN_NAME}')); return item ? item.getAttribute('title') || '' : ''; })()`,
);
if (!pinyinKind.includes("拼音")) throw new Error(`拼音命中应标注来源: ${pinyinKind}`);
log("PASS 拼音首字母 xmjh → 命中 项目计划（snippet 标注拼音）");
await typeSearch("xiangmujihua");
await waitFor(
  `[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('${CN_NAME}'))`,
  "拼音全拼 xiangmujihua 命中中文文件名",
  20000,
);
log("PASS 拼音全拼 xiangmujihua → 命中 项目计划");

// ---- 3c. 清单数据内容命中（用户优化项 C9）----
const CL_WORD = `e2e-clist-zzz-${Date.now()}`;
mkdirSync(path.join(VAULT, "data", "checklists"), { recursive: true });
writeFileSync(
  path.join(VAULT, "data", "checklists", `e2e-clist-${Date.now()}.json`),
  JSON.stringify({ id: "e2e-clist", title: "E2E 采购清单", items: [{ text: `内容 ${CL_WORD}` }] }),
  "utf8",
);
await typeSearch(CL_WORD);
await waitFor(
  `[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('data/checklists/e2e-clist-'))`,
  "清单数据内容命中",
  20000,
);
log("PASS 清单数据（data/checklists/*.json）内容可被搜索命中");

// ---- 4. 点击结果 → 切到笔记视图并真正打开目标文件 ----
await typeSearch(TOKEN);
await waitFor(
  `[...document.querySelectorAll('.search-dropdown .search-item')].some(i => i.textContent.includes('${NAME}'))`,
  "重新输入后目标文件出现",
  20000,
);
const clicked = await ev(
  `(() => { const item = [...document.querySelectorAll('.search-dropdown .search-item')].find(i => i.textContent.includes('${NAME}')); if (!item) return false; item.click(); return true; })()`,
);
if (!clicked) throw new Error("无法点击搜索结果");
// 防御：前序套件（cdp-notes-ui 内部搜索）可能残留 showingSearch 遮蔽编辑器，
// 打开前清空 notes 内部搜索词，确保 editor-title 渲染
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .files-search-input');
  if (el && el.value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()`);
await waitFor(
  `document.querySelector('.plugin-ui-view .editor-title')?.textContent === ${JSON.stringify(`projects/${NAME}`)}`,
  "笔记视图打开目标文件",
  20000,
);
log("PASS 点击搜索结果 → 笔记视图打开目标文件");

log("\n========== SEARCH_GLOBAL_E2E_PASS ==========");
process.exit(0);
