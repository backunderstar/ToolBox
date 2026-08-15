// 通用 UI 截图：导航到指定视图并保存 PNG。
// 用法: node scripts/cdp-shots.mjs <outDir> [port]
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const OUT_DIR = process.argv[2] ?? "shots";
const PORT = process.argv[3] ?? "9226";
mkdirSync(OUT_DIR, { recursive: true });

const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri\.localhost/.test(t.url)) ?? targets.find((t) => t.type === "page");
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
  if (r.result?.exceptionDetails) console.error("EVAL_ERR:", r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 2000));

const shot = async (name) => {
  const s = await send("Page.captureScreenshot", { format: "png" });
  const p = join(OUT_DIR, name);
  writeFileSync(p, Buffer.from(s.result.data, "base64"));
  console.log("saved", p);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = async (label) => {
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
};
const toggleTheme = async () => {
  await ev(`(() => { const b = document.querySelector('header button[title*="主题"]'); if (b) b.click(); return !!b; })()`);
  await sleep(600);
};

// 1. 欢迎页（overview）
await shot("01-welcome-light.png");
// 2. 笔记视图（亮）
await ev(`(() => { const b = document.querySelector('.welcome .btn-primary'); if (b) b.click(); return !!b; })()`);
await sleep(2500);
// 打开一篇笔记
await ev(`(() => { const rows=[...document.querySelectorAll('.tree-row')]; const n=rows.find(r=>r.textContent.trim().endsWith('.md')); if(n) n.click(); return !!n; })()`);
await sleep(2000);
await shot("02-notes-light.png");
// 3. 暗色笔记
await toggleTheme();
await sleep(800);
await shot("03-notes-dark.png");
// 4. 设置
await nav("设置");
await shot("04-settings-dark.png");
// 5. 插件
await nav("插件");
await shot("05-plugins-dark.png");
// 6. 项目
await nav("项目");
await shot("06-projects-dark.png");
// 7. 数据工具
await nav("数据工具");
await shot("07-tools-dark.png");
// 回亮色
await toggleTheme();
await sleep(600);
// 8. 清单
await nav("清单");
await shot("08-checklist-light.png");
// 9. 记录
await nav("记录");
await shot("09-records-light.png");

ws.close();
console.log("=== DONE ===");
process.exit(0);
