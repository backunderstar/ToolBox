// cdp-notes-ui.mjs — core-notes 插件自带前端 E2E：挂载/文件树/打开笔记(Vditor)/自动保存/新建/搜索
import { findMainPage, connect, sleep, helpers } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const VAULT = "D:\\WORKSPACE\\ToolBox\\src-tauri\\target\\e2e-vault";
const page = await findMainPage(PORT);
if (!page) {
  console.error("no main page");
  process.exit(1);
}
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);

await sleep(800);

// ---- 1. 笔记视图渲染插件自带前端（非宿主 NotesView）----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
await clickText(".nav-item", "笔记");
await waitFor(`!!document.querySelector('.plugin-ui-view .notes')`, "插件自带界面挂载");
const hostView = await ev(`!!document.querySelector('.notes:not(.plugin-ui-view .notes)')`);
if (hostView) throw new Error("宿主 NotesView 与插件界面并存（应只渲染插件界面）");
log("PASS 笔记页渲染插件自带前端（core-notes ui/index.js）");

// ---- 2. 文件树经桥加载 + 自带搜索框 ----
await waitFor(`document.querySelectorAll('.plugin-ui-view .tree-row').length >= 1`, "文件树出现");
await waitFor(`!!document.querySelector('.plugin-ui-view .files-search-input')`, "插件自带搜索框");
const rows = await ev(
  `[...document.querySelectorAll('.plugin-ui-view .tree-row')].map(r => ({ name: r.querySelector('.tree-name')?.textContent, path: r.dataset.path }))`,
);
if (!rows.some((r) => r.path?.endsWith(".md")))
  throw new Error(`文件树无 Markdown: ${JSON.stringify(rows)}`);
log(
  `PASS 文件树经桥加载（${rows.length} 项：${rows
    .slice(0, 3)
    .map((r) => r.name)
    .join("/")}…）`,
);

// ---- 3. 打开笔记 → Vditor 初始化（先清空可能的遗留搜索词，避免搜索结果盖住编辑器）----
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .files-search-input');
  if (el && el.value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()`);
await sleep(400);
const row =
  rows.find((r) => r.name?.includes("示例笔记")) ?? rows.find((r) => r.path?.endsWith(".md"));
await ev(
  `(() => { const el = [...document.querySelectorAll('.plugin-ui-view .tree-row')].find(r => r.dataset.path === ${JSON.stringify(row.path)}); el?.click(); return !!el; })()`,
);
// 等待目标笔记真正打开（标题匹配 + Vditor 就绪；旧笔记的 Vditor 可能仍在，需先等标题切换）
await waitFor(
  `document.querySelector('.plugin-ui-view .editor-title')?.textContent === ${JSON.stringify(row.path)} && !!document.querySelector('.plugin-ui-view .editor-host.vditor')`,
  "目标笔记打开且 Vditor 初始化",
);

// ---- 4. 输入触发自动保存（写入经桥 + DLL，磁盘校验）----
const marker = `E2E标记${Date.now().toString(36)}`;
await ev(`(() => {
  const ed = document.querySelector('.plugin-ui-view .vditor-ir') || document.querySelector('.plugin-ui-view .vditor-content');
  if (!ed) return false;
  ed.focus();
  document.execCommand('insertText', false, ${JSON.stringify(marker)});
  return true;
})()`);
await sleep(400);
const dirtyOn = await ev(
  `document.querySelector('.plugin-ui-view .dirty-dot')?.classList.contains('on')`,
);
if (!dirtyOn) {
  // Vditor IR 可能有自己的输入管线，改用直接向 Vditor 实例派发输入：先尝试内容比对
  const edText = await ev(
    `(document.querySelector('.plugin-ui-view .vditor-ir')?.textContent ?? '')`,
  );
  if (!edText.includes(marker)) throw new Error("输入未进入编辑器（dirty-dot 未亮且内容无标记）");
  log("PASS 输入已进入编辑器（Vditor 内容含标记；跳过 dirty 校验）");
} else {
  log("PASS 输入 → dirty-dot 亮起");
}
// 等待防抖自动保存（800ms）+ 落盘
await sleep(1800);
const disk = await ev(`(async () => {
  try {
    const txt = await window.__TAURI_INTERNALS__.invoke('plugin_call', { vault: ${JSON.stringify(VAULT)}, id: 'core-notes', command: 'notes.read', args: { rel: ${JSON.stringify(row.path)} } });
    return typeof txt === 'string' && txt.includes(${JSON.stringify(marker)}) ? 'OK' : 'MISS';
  } catch (e) { return 'ERR:' + e; }
})()`);
if (disk !== "OK") throw new Error(`自动保存未落盘（磁盘校验: ${disk}）`);
log("PASS 输入 → 防抖自动保存落盘（notes.write 经桥 + DLL，磁盘含标记）");

// ---- 4b. 手动保存 → 编辑器底部状态条显示反馈（flash 消息）----
await ev(`(() => {
  const b = [...document.querySelectorAll('.plugin-ui-view .editor-header button')].find(b => b.textContent.includes('保存'));
  b?.click(); return !!b;
})()`);
await waitFor(
  `(document.querySelector('.plugin-ui-view .editor-status')?.textContent || '').includes('已保存')`,
  "状态条显示保存反馈",
);
log("PASS 手动保存 → 状态条显示「已保存」");

// ---- 5. 新建笔记 ----
const before = await ev(`document.querySelectorAll('.plugin-ui-view .tree-row').length`);
await ev(
  `(() => { const b = [...document.querySelectorAll('.plugin-ui-view .files-header button')].find(b => b.title === '新建笔记'); b?.click(); return !!b; })()`,
);
await waitFor(
  `document.querySelectorAll('.plugin-ui-view .tree-row').length > ${before}`,
  "新笔记出现在文件树",
);
await waitFor(
  `(document.querySelector('.plugin-ui-view .editor-title')?.textContent || '').startsWith('notes/笔记-')`,
  "新笔记自动打开",
);
log("PASS 新建笔记（文件树 +1 并自动打开）");

// ---- 6. 插件自带搜索框（跨插件 core-search）----
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .files-search-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'E2E');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
// 等待搜索完成（"检索中…"消失；.search-results 在结果到达前就已渲染）
await waitFor(
  `!!document.querySelector('.plugin-ui-view .search-results') && !(document.querySelector('.plugin-ui-view .search-results .search-hint')?.textContent.includes('检索中'))`,
  "搜索完成（跨插件 core-search）",
);
const resCount = await ev(`document.querySelectorAll('.plugin-ui-view .result-item').length`);
if (resCount < 1) throw new Error("搜索应有命中（E2E 笔记含关键词）");
log(`PASS 自带搜索框命中 ${resCount} 条（宿主内嵌搜索经统一桥）`);

// ---- 7. 清理：清空内部搜索词 ----
// 否则 showingSearch（query 非空）残留会遮蔽编辑器，导致后续套件
// （cdp-search-global 点击搜索结果后断言 editor-title）等待超时。
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .files-search-input');
  if (el && el.value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()`);
await sleep(400);
const cleared = await ev(
  `!document.querySelector('.plugin-ui-view .search-results')`,
);
if (!cleared) throw new Error("清理搜索词后应退出搜索模式（.search-results 应消失）");
log("PASS 清理内部搜索词（退出搜索模式，不污染后续套件）");

log("\n========== NOTES_UI_E2E_PASS ==========");
process.exit(0);
