// 插件全局化 E2E（验证部分；setup 由外部 PowerShell 在启动 dev 前完成）：
// 1) e2e-vault/plugins 预置旧布局 → 进插件页触发迁移
// 2) 断言：vault/plugins 被清（回收站）、全局目录有插件、webview/process 插件都可用
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PORT = process.argv[2] ?? "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const globalPlugins = join(process.env.APPDATA, "com.toolbox.desktop", "plugins");
const vault = "src-tauri/target/e2e-vault";

const vaultPlugins = join(vault, "plugins");

const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri/.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
const waitFor = async (expr, timeoutMs = 20000, interval = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ev(expr)) return true;
    await sleep(interval);
  }
  return false;
};

await send("Runtime.enable");
await sleep(800);

// 进插件视图（触发 plugins_list → 迁移 + 全局扫描）
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('插件')); if (b) b.click(); return !!b; })()`);
const cards = await waitFor(`document.querySelectorAll('.plugin-card').length >= 2`, 20000);
console.log("[list] two plugins:", cards ? "OK" : "MISSING");

// 断言 1：vault/plugins 已被迁移清理
await sleep(1000);
const vaultCleaned = !existsSync(vaultPlugins);
console.log("[migrate] vault/plugins cleaned:", vaultCleaned ? "OK" : "FAIL");

// 断言 2：全局目录已有插件
const globalIds = existsSync(globalPlugins) ? readdirSync(globalPlugins) : [];
console.log("[migrate] global plugins:", JSON.stringify(globalIds));
const globalOk = ["csv-tool", "text-stats"].every((x) => globalIds.includes(x));

// 断言 3：webview 插件（text-stats）启用后应就绪（说明 plugins_read_file 入口读取 + 前端加载成功）
await ev(`(() => {
  const cards = [...document.querySelectorAll('.plugin-card')];
  const card = cards.find(x => x.textContent.includes('文本统计') || x.textContent.includes('text-stats'));
  if (!card) return false;
  const b = [...card.querySelectorAll('button')].find(x => x.textContent.trim() === '启用');
  if (b) b.click();
  return true;
})()`);
const wsOk = await waitFor(`(() => {
  const cards = [...document.querySelectorAll('.plugin-card')];
  const c = cards.find(x => x.textContent.includes('文本统计') || x.textContent.includes('text-stats'));
  return c ? c.textContent.includes('就绪') : false;
})()`, 15000);
console.log("[webview] text-stats ready:", wsOk ? "OK" : "FAIL");

// 断言 4：process 插件（csv-tool）命令可用（从全局目录启动 Python）
await ev(`(() => {
  const cards = [...document.querySelectorAll('.plugin-card')];
  const card = cards.find(x => x.textContent.includes('csv-tool') || x.textContent.includes('CSV'));
  if (!card) return false;
  const b = [...card.querySelectorAll('button')].find(x => x.textContent.trim() === '启用');
  if (b) b.click();
  return true;
})()`);
await sleep(1500);
const csvReady = await waitFor(`(() => {
  const cards = [...document.querySelectorAll('.plugin-card')];
  const c = cards.find(x => x.textContent.includes('csv-tool') || x.textContent.includes('CSV'));
  return c ? c.textContent.includes('就绪') : false;
})()`, 20000);
console.log("[process] csv-tool ready:", csvReady ? "OK" : "FAIL");

const pass = cards && vaultCleaned && globalOk && wsOk && csvReady;
ws.close();
console.log(pass ? "PLUGIN_GLOBAL_PASS" : "PLUGIN_GLOBAL_FAIL");
process.exit(pass ? 0 : 1);
