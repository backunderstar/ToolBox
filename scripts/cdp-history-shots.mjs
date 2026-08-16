// 版本历史视图截图：时间线 / 展开详情 / 暗色
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const OUT_DIR = process.argv[2] ?? "shots-history";
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
const shot = async (name) => {
  const s = await send("Page.captureScreenshot", { format: "png" });
  const p = join(OUT_DIR, name);
  writeFileSync(p, Buffer.from(s.result.data, "base64"));
  console.log("saved", p);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1500));

// 进版本历史视图
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('版本历史')); if (b) b.click(); return !!b; })()`);
await sleep(1500);
await shot("01-history-light.png");

// 展开最新提交
await ev(`(() => { const h = document.querySelector('.history-commit-head'); if (h) h.click(); return !!h; })()`);
await sleep(800);
await shot("02-history-expanded-light.png");

// 暗色
await ev(`(() => { const b = document.querySelector('header button[title*="主题"]'); if (b) b.click(); return !!b; })()`);
await sleep(800);
await shot("03-history-dark.png");

ws.close();
console.log("=== DONE ===");
process.exit(0);
