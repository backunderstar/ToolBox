// cdp-external-ui.mjs — 外部插件能力 E2E：
// 1) 外部插件 nav 入口进侧边栏（text-stats 声明 nav + ui）
// 2) 点击 → App 动态路由 → 插件自带前端挂载
// 3) 界面内实时统计功能
// 4) Python 进程插件（py-tools，vendored 第三方库）加载与命令调用
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

// ---- 1. 侧边栏出现外部插件入口（text-stats 的 nav 声明） ----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
const hasNav = await ev(`[...document.querySelectorAll('.nav-item')].some(e => e.textContent.trim() === '文本统计')`);
if (!hasNav) throw new Error("侧边栏应有 text-stats 的「文本统计」入口（外部插件 nav 放开后）");
log("PASS 外部插件 nav 入口进侧边栏（text-stats「文本统计」）");

// ---- 2. 点击 → App 动态路由 → 自带前端挂载 ----
await clickText(".nav-item", "文本统计");
await waitFor(`!!document.querySelector('.text-stats-input')`, "text-stats 自带前端挂载");
log("PASS 点击导航 → App 动态路由 → 插件自带前端挂载");

// ---- 3. 界面内实时统计 ----
const setText = await ev(`(() => { const ta = document.querySelector('.text-stats-input'); if (!ta) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '你好 world\\n第二行\\n\\n第三段'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
if (!setText) throw new Error("无法写入统计输入框");
await sleep(300);
const vals = await ev(`(() => { const spans = [...document.querySelectorAll('.stat-value')]; return spans.map(s => s.textContent).join(','); })()`);
log(`PASS 界面内实时统计（字符/词/行/段 = ${vals}）`);
if (!vals.startsWith("17")) throw new Error(`字符数应含 17（你好 world\n第二行\n\n第三段）: ${vals}`);
if (!vals.endsWith(",2")) throw new Error(`段落数应含 2（两个空行分隔）: ${vals}`);

// ---- 4. Python 进程插件 py-tools：加载 + 命令调用（vendored dateutil） ----
await clickText(".nav-item", "插件");
await waitFor(`document.querySelectorAll('.plugin-card').length >= 3`, "插件页加载（含 py-tools）");
const pyOk = await ev(`[...document.querySelectorAll('.plugin-card')].some(c => c.querySelector('.plugin-title h2')?.textContent.includes('Python 文本工具'))`);
if (!pyOk) throw new Error("插件页应有 py-tools（Python 文本工具）");
log("PASS py-tools（process Python 插件）出现在插件页");
// 外部插件默认禁用：点"启用"（已是"禁用"按钮 = 已启用）
await ev(`(() => {
  const card = [...document.querySelectorAll('.plugin-card')].find(c => c.querySelector('.plugin-title h2')?.textContent.includes('Python 文本工具'));
  const btn = [...(card?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '启用');
  if (btn) btn.click();
  return true;
})()`);
await waitFor(`[...document.querySelectorAll('.plugin-card')].some(c => c.querySelector('.plugin-title h2')?.textContent.includes('Python 文本工具') && [...c.querySelectorAll('button')].some(b => b.textContent.trim() === '禁用'))`, "py-tools 已启用", 15000);
log("PASS py-tools 已启用");
// 经前端 invoke 调 pytext.humanDate（dateutil 真实工作）：
// 通过统一桥的全局 API 不好直接拿，用插件页命令试用台的内部调用路径——
// 简化：直接 evaluate 调用 window.__TAURI_INTERNALS__ 的 plugin_call（Rust 路由）
const callRes = await ev(`(async () => {
  try {
    const inv = window.__TAURI_INTERNALS__.invoke;
    const v = await inv('vault_get');
    const res = await inv('plugin_call', { vault: v.path, id: 'py-tools', command: 'pytext.humanDate', args: { date: '2024-03-01T14:30:00+08:00', fmt: '%Y/%m/%d %H:%M' } });
    return JSON.stringify(res);
  } catch (e) { return 'ERR:' + String(e); }
})()`);
if (!callRes.includes("2024/03/01")) throw new Error(`pytext.humanDate 应返回格式化日期: ${callRes}`);
log(`PASS py-tools 命令经 plugin_call 调用（dateutil 解析+格式化: ${callRes}）`);

log("\n========== EXTERNAL_UI_E2E_PASS ==========");
process.exit(0);
