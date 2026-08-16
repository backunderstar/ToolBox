// 插件事件桥 E2E：启用 csv-tool → 调用 csv.eventTest → 插件事件实时出现在事件日志
import { copyFileSync, existsSync } from "node:fs";

const PORT = process.argv[2] ?? "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// e2e-vault 里的 csv-tool 是旧副本——先同步最新 main.py（含 eventTest 命令）
const vaultBase = process.argv[3] ?? "src-tauri/target/e2e-vault";
const dst = `${vaultBase}/plugins/csv-tool/main.py`;
if (existsSync(dst)) {
  copyFileSync("plugins/csv-tool/main.py", dst);
  console.log("[sync] main.py 已同步到 e2e-vault");
}
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
const waitFor = async (expr, timeoutMs = 20000, interval = 400) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await ev(expr);
    if (v) return v;
    await sleep(interval);
  }
  return false;
};

await send("Runtime.enable");
await sleep(800);

// 进插件视图
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes('插件')); if (b) b.click(); return !!b; })()`);
await sleep(1500);

// csv-tool 卡片：启用或重新加载（确保加载的是含 eventTest 的新 main.py）
const cardAction = await ev(`(() => {
  const cards = [...document.querySelectorAll('.plugin-card')];
  const card = cards.find(c => c.textContent.includes('csv-tool') || c.textContent.includes('CSV'));
  if (!card) return 'NO_CARD';
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '启用');
  if (btn) { btn.click(); return 'ENABLING'; }
  const reload = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '重新加载');
  if (reload) { reload.click(); return 'RELOADING'; }
  return 'ALREADY';
})()`);
console.log("[csv-tool] action:", cardAction);

// 找到 csv.eventTest 命令的"试用"按钮并展开
const chip = await waitFor(`(() => {
  const chips = [...document.querySelectorAll('.command-chip')];
  const chip = chips.find(c => c.textContent.includes('csv.eventTest') || c.textContent.includes('eventTest'));
  if (!chip) return false;
  const tryBtn = chip.querySelector('.command-try');
  if (tryBtn && tryBtn.textContent.includes('试用')) tryBtn.click();
  return true;
})()`, 25000);
console.log("[eventTest] chip:", chip ? "OK" : "MISSING");
await sleep(800);

// 运行命令（展开面板里的"运行"按钮）
const runOk = await ev(`(() => {
  const btns = [...document.querySelectorAll('.try-panel button')];
  const b = btns.find(x => x.textContent.trim() === '运行');
  if (b) { b.click(); return true; }
  return false;
})()`);
console.log("[eventTest] run:", runOk ? "OK" : "MISSING");

// 等待事件日志出现并校验内容
const logShown = await waitFor(`!!document.querySelector('.plugin-events')`, 25000);
const logText = logShown
  ? await ev(`[...document.querySelectorAll('.plugin-event')].map(e => e.textContent).join('\\n')`)
  : "";
console.log("[events] log shown:", logShown ? "OK" : "MISSING");
console.log("[events] sample:", JSON.stringify(logText.slice(0, 200)));
const progressCount = (logText.match(/progress/g) ?? []).length;
const hasPluginId = logText.includes("csv-tool");
const hasPercent = logText.includes("percent");
console.log("[events] progress count:", progressCount, "| pluginId:", hasPluginId, "| percent:", hasPercent);

const pass = logShown && progressCount >= 1 && hasPluginId && hasPercent;
ws.close();
console.log(pass ? "EVENT_BRIDGE_PASS" : "EVENT_BRIDGE_FAIL");
process.exit(pass ? 0 : 1);
