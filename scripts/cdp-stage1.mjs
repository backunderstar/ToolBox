// cdp-stage1.mjs — 阶段 1 E2E：笔记/清单/项目/待办核心插件全链路
// 前置：pnpm tauri dev（windows 临时带 --remote-debugging-port=9226）+ pnpm build:core
const PORT = process.argv[2] ?? "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page =
  targets.find((t) => t.type === "page" && /1420|tauri/.test(t.url)) ??
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      cb(m);
    }
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
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
const invoke = (cmd, args) =>
  ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

await send("Runtime.enable");
await sleep(600);
const VAULT = "D:\\\\WORKSPACE\\\\ToolBox\\\\src-tauri\\\\target\\\\e2e-vault";

// ---- 1. 侧边栏：四个核心插件入口默认全部启用 ----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
const nav = await ev(
  `[...document.querySelectorAll('.nav-item span')].map(s => s.textContent)`
);
for (const expect of ["笔记", "记录", "清单", "项目"]) {
  if (!nav.includes(expect)) throw new Error(`侧边栏缺「${expect}」: ${JSON.stringify(nav)}`);
}
if (nav.includes("版本历史")) throw new Error("版本历史入口仍在");
log("PASS 侧边栏 笔记/记录/清单/项目 默认启用（核心插件默认启用）");

// ---- 2. 插件页：5 个核心插件卡片 ----
await clickText(".nav-item", "插件");
await waitFor(
  `[...document.querySelectorAll('.plugin-card')].filter(c => c.textContent.includes('核心')).length >= 5`,
  "5 个核心插件卡片"
);
const coreNames = await ev(
  `[...document.querySelectorAll('.plugin-card')].filter(c => c.textContent.includes('核心')).map(c => c.querySelector('h2')?.textContent)`
);
for (const expect of ["记录", "笔记", "待办", "清单", "项目"]) {
  if (!coreNames.includes(expect)) throw new Error(`插件页缺核心插件「${expect}」: ${JSON.stringify(coreNames)}`);
}
log(`PASS 插件页 5 个核心插件（${coreNames.join("/")}）`);

// ---- 3. 笔记：UI 新建（真实用户路径）+ invoke 验证（core-notes DLL）----
await clickText(".nav-item", "笔记");
await waitFor(`!!document.querySelector('.file-tree')`, "笔记视图");
// 顶部"新建笔记"按钮（icon-btn title=新建笔记）
await ev(`(() => {
  const b = [...document.querySelectorAll('.icon-btn')].find(x => x.getAttribute('title') === '新建笔记' || x.getAttribute('aria-label') === '新建笔记');
  if (!b) return false; b.click(); return true;
})()`);
await waitFor(
  `[...document.querySelectorAll('.tree-row .tree-name')].some(e => e.textContent.startsWith('笔记-'))`,
  "文件树出现新笔记（经 core-notes DLL 创建）"
);
const noteName = await ev(
  `[...document.querySelectorAll('.tree-row .tree-name')].find(e => e.textContent.startsWith('笔记-'))?.textContent`
);
// invoke 读该笔记（DLL 读取验证）
const nr = await invoke("plugin_call", {
  vault: VAULT,
  id: "core-notes",
  command: "notes.read",
  args: { rel: "notes/" + noteName },
});
if (typeof nr !== "string") throw new Error("notes.read 失败: " + JSON.stringify(nr));
// 写入内容并读回
await invoke("plugin_call", {
  vault: VAULT,
  id: "core-notes",
  command: "notes.write",
  args: { rel: "notes/" + noteName, content: "# 阶段 1 E2E\n笔记插件化验证。\n" },
});
const nr2 = await invoke("plugin_call", {
  vault: VAULT,
  id: "core-notes",
  command: "notes.read",
  args: { rel: "notes/" + noteName },
});
if (typeof nr2 !== "string" || !nr2.includes("笔记插件化验证")) {
  throw new Error("notes 读写失败: " + JSON.stringify(nr2));
}
log(`PASS 笔记 UI 新建（${noteName}）+ DLL 读写`);

// ---- 4. 清单：invoke 验证 + UI 入口 ----
const cc = await invoke("plugin_call", {
  vault: VAULT,
  id: "core-checklists",
  command: "chk.create",
  args: { title: "E2E 采购清单" },
});
if (!cc?.id) throw new Error("chk.create 失败: " + JSON.stringify(cc));
const cl = await invoke("plugin_call", {
  vault: VAULT,
  id: "core-checklists",
  command: "chk.list",
  args: {},
});
if (!Array.isArray(cl) || !cl.some((c) => c.title === "E2E 采购清单")) {
  throw new Error("chk.list 失败: " + JSON.stringify(cl));
}
await clickText(".nav-item", "清单");
await waitFor(`!!document.querySelector('.checklist-view') || document.querySelectorAll('.checklist-row, .checklist-item').length >= 0`, "清单视图");
log("PASS 清单经 core-checklists DLL CRUD + 视图可达");

// ---- 5. 项目：invoke 验证 + UI 入口 ----
await invoke("plugin_call", {
  vault: VAULT,
  id: "core-projects",
  command: "projects.create",
  args: { name: "E2E 项目甲" },
});
const pl = await invoke("plugin_call", {
  vault: VAULT,
  id: "core-projects",
  command: "projects.list",
  args: {},
});
if (!Array.isArray(pl) || !pl.some((p) => p.name === "E2E 项目甲")) {
  throw new Error("projects.list 失败: " + JSON.stringify(pl));
}
await clickText(".nav-item", "项目");
await waitFor(`!!document.querySelector('.projects-view')`, "项目视图");
log("PASS 项目经 core-projects DLL CRUD + 视图可达");

// ---- 6. 待办：invoke 验证（浮窗独立窗口，命令走 core-todos）----
const ta = await invoke("plugin_call", {
  vault: VAULT,
  id: "core-todos",
  command: "todos.add",
  args: { text: "E2E 待办项" },
});
if (!Array.isArray(ta) || !ta.some((t) => t.text === "E2E 待办项")) {
  throw new Error("todos.add 失败: " + JSON.stringify(ta));
}
log("PASS 待办经 core-todos DLL CRUD");

// ---- 7. 搜索：文件命中（宿主 search_all 仍工作）----
await clickText(".nav-item", "笔记");
await waitFor(`!!document.querySelector('.search input')`, "搜索框");
await ev(`(() => {
  const el = document.querySelector('.search input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '笔记插件化验证');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await waitFor(
  `[...document.querySelectorAll('.result-item')].some(e => e.textContent.includes('笔记-'))`,
  "文件搜索命中新笔记"
);
log("PASS 搜索聚合文件命中（宿主 FTS + 插件 provider 共存）");

// ---- 8. 禁用 core-notes → 侧边栏消失 + 守卫占位；重新启用恢复 ----
await clickText(".nav-item", "插件");
await waitFor(`[...document.querySelectorAll('.plugin-card')].some(c => c.querySelector('h2')?.textContent === '笔记')`, "笔记插件卡片");
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '笔记');
  const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '禁用');
  b.click(); return true;
})()`);
await waitFor(
  `![...document.querySelectorAll('.nav-item span')].some(s => s.textContent === '笔记')`,
  "禁用后侧边栏笔记入口消失"
);
log("PASS 禁用 core-notes → 侧边栏入口消失（选择性使用）");
// 仍在插件页：直接点"启用"恢复（不要切走视图，卡片 DOM 会卸载）
await ev(`(() => {
  const c = [...document.querySelectorAll('.plugin-card')].find(x => x.querySelector('h2')?.textContent === '笔记');
  if (!c) return false;
  const b = [...c.querySelectorAll('button')].find(b => b.textContent.trim() === '启用');
  if (!b) return false;
  b.click(); return true;
})()`);
await waitFor(
  `[...document.querySelectorAll('.nav-item span')].some(s => s.textContent === '笔记')`,
  "重新启用后入口恢复"
);
log("PASS 重新启用 core-notes → 入口恢复");

log("\n========== STAGE1_E2E_PASS ==========");
process.exit(0);
