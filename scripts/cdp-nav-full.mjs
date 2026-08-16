// cdp-nav-full.mjs — 导航栏全配置 E2E：默认渲染/折叠/新建分组/拖拽跨组/改标签/隐藏/恢复默认
import { findMainPage, connect, sleep, helpers } from "./cdp-lib.mjs";
const page = await findMainPage("9226");
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);
const navLabels = () =>
  ev(`[...document.querySelectorAll('.sidebar .nav-item span')].map(e => e.textContent.trim())`);
const groupLabels = () =>
  ev(
    `[...document.querySelectorAll('.sidebar .nav-group-head .nav-label')].map(e => e.textContent.trim())`,
  );

await sleep(1500);

// ---- 0. 重置导航配置（清 localStorage 后刷新，测试默认+迁移）----
await ev(`localStorage.removeItem('toolbox.nav')`);
await sendReload();
await sleep(2000);
let labels = await navLabels();
console.log("侧边栏项:", labels.join(" | "));
for (const expect of ["概览", "插件", "设置", "笔记", "清单", "项目", "AI 整理", "博客发布"]) {
  if (!labels.includes(expect)) throw new Error(`缺 ${expect}: ${labels.join(",")}`);
}
const gl = await groupLabels();
console.log("分组:", gl.join(" | "));
if (!gl.includes("工作区") || !gl.includes("系统")) throw new Error(`分组异常: ${gl.join(",")}`);
log("PASS 默认渲染（8 项，工作区/系统两组，旧配置可迁移）");

// ---- 1. 分组折叠 ----
await clickText(".sidebar .nav-group-head", "系统");
await sleep(300);
labels = await navLabels();
if (labels.includes("AI 整理") || labels.includes("博客发布") || labels.includes("设置")) {
  throw new Error("折叠后系统组项仍显示");
}
if (!labels.includes("概览")) throw new Error("折叠系统组不应影响工作区组");
await clickText(".sidebar .nav-group-head", "系统");
await sleep(300);
labels = await navLabels();
if (!labels.includes("AI 整理") || !labels.includes("设置")) throw new Error("展开后系统组应恢复");
log("PASS 分组折叠/展开（记忆持久化）");

// ---- 2. 设置页：新建分组 ----
await clickText(".nav-item", "设置");
await waitFor(`!!document.querySelector('.nav-settings-group')`, "导航栏设置卡片");
await clickText(".settings-actions button", "新建分组");
await waitFor(`!!document.querySelector('.nav-settings-newgroup-input')`, "新分组输入框");
await ev(`(() => {
  const el = document.querySelector('.nav-settings-newgroup-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '我的收藏');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await clickText(".nav-settings-newgroup button", "创建");
await waitFor(
  `[...document.querySelectorAll('.nav-settings-group-name')].some(e => e.value === '我的收藏')`,
  "新分组出现",
);
log("PASS 新建分组「我的收藏」");

// ---- 3. 拖拽跨组：把「笔记」拖到「我的收藏」----
// 注意：每行有「移动到…」下拉（select 的 option 含所有分组名，会污染 textContent），
// 查找行一律用 .nav-settings-label 精确匹配
const dragged = await ev(`(() => {
  const row = [...document.querySelectorAll('.nav-settings-row')].find(r => r.querySelector('.nav-settings-label')?.textContent === '笔记');
  if (!row) return false;
  row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
  return true;
})()`);
if (!dragged) throw new Error("未找到笔记设置行");
// 找到「我的收藏」组容器并 drop
const dropped = await ev(`(() => {
  const group = [...document.querySelectorAll('.nav-settings-group')].find(g => g.querySelector('.nav-settings-group-name')?.value === '我的收藏');
  if (!group) return false;
  group.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true }));
  group.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
  return true;
})()`);
if (!dropped) throw new Error("未找到我的收藏组");
await waitFor(
  `(() => {
  const group = [...document.querySelectorAll('.nav-settings-group')].find(g => g.querySelector('.nav-settings-group-name')?.value === '我的收藏');
  return group ? group.textContent.includes('笔记') : false;
})()`,
  "笔记出现在我的收藏组",
);
log("PASS 拖拽「笔记」→「我的收藏」（跨组移动）");

// ---- 3b. 按钮式跨组移动（每行的「移动到…」下拉，不依赖拖拽）----
const selMoved = await ev(`(() => {
  const row = [...document.querySelectorAll('.nav-settings-row')].find(r => r.querySelector('.nav-settings-label')?.textContent === '清单');
  const sel = row?.querySelector('.nav-settings-move');
  if (!sel) return false;
  const opt = [...sel.options].find(o => o.textContent === '我的收藏');
  if (!opt) return false;
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
if (!selMoved) throw new Error("未找到「清单」行的移动到下拉");
await waitFor(
  `(() => {
  const group = [...document.querySelectorAll('.nav-settings-group')].find(g => g.querySelector('.nav-settings-group-name')?.value === '我的收藏');
  return group ? group.textContent.includes('清单') : false;
})()`,
  "清单出现在我的收藏组",
);
log("PASS 按钮式「移动到…」把「清单」移入「我的收藏」（不依赖拖拽）");

// ---- 4. 改标签 + 图标 ----
await ev(`(() => {
  const row = [...document.querySelectorAll('.nav-settings-row')].find(r => r.querySelector('.nav-settings-label')?.textContent === '笔记');
  const btn = row && [...row.querySelectorAll('button')].find(b => b.title.includes('编辑标签'));
  btn?.click(); return !!btn;
})()`);
await waitFor(`!!document.querySelector('.nav-settings-meta-editor')`, "编辑表单");
await ev(`(() => {
  const el = document.querySelector('.nav-settings-meta-label');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '我的笔记');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await clickText(".nav-settings-meta-editor button", "保存");
await sleep(300);
// 回到侧边栏验证
await ev(
  `(() => { const el = [...document.querySelectorAll('.sidebar .nav-item')].find(e => e.textContent.includes('设置')); el?.click(); return !!el; })()`,
);
await sleep(300);
labels = await navLabels();
console.log("侧边栏项（改标签后）:", labels.join(" | "));
if (!labels.includes("我的笔记")) throw new Error("侧边栏未显示改标签后的「我的笔记」");
if (labels.includes("笔记")) throw new Error("旧标签仍存在（应为覆盖）");
log("PASS 改标签「笔记」→「我的笔记」（侧边栏生效）");

// ---- 5. 隐藏「插件」----
await clickText(".sidebar .nav-item", "设置");
await waitFor(`!!document.querySelector('.nav-settings-group')`, "回到设置");
await ev(`(() => {
  const row = [...document.querySelectorAll('.nav-settings-row')].find(r => r.textContent.includes('插件'));
  const sw = row?.querySelector('.switch input');
  sw?.click(); return !!sw;
})()`);
await sleep(300);
await ev(
  `(() => { const el = [...document.querySelectorAll('.sidebar .nav-item')].find(e => e.textContent.includes('设置')); el?.click(); return !!el; })()`,
);
await sleep(300);
labels = await navLabels();
if (labels.includes("插件")) throw new Error("隐藏后插件仍在");
log("PASS 隐藏「插件」（侧边栏消失）");

// ---- 6. 恢复默认 ----
await clickText(".sidebar .nav-item", "设置");
await waitFor(`!!document.querySelector('.settings-actions')`, "设置操作区");
await clickText(".settings-actions button", "恢复默认");
await sleep(300);
await ev(
  `(() => { const el = [...document.querySelectorAll('.sidebar .nav-item')].find(e => e.textContent.includes('设置')); el?.click(); return !!el; })()`,
);
await sleep(300);
labels = await navLabels();
console.log("恢复默认后:", labels.join(" | "));
for (const expect of ["概览", "插件", "设置", "笔记", "清单", "项目", "AI 整理", "博客发布"]) {
  if (!labels.includes(expect)) throw new Error(`恢复默认后缺 ${expect}`);
}
log("PASS 恢复默认（8 项全部回归）");

log("\n========== NAV_FULL_E2E_PASS ==========");
process.exit(0);

async function sendReload() {
  // 简单刷新：location.reload
  await ev("location.reload()");
}
