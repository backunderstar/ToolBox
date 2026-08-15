// Clean-room final E2E: fresh app instance, no reload, verify everything + errors.
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url));
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(e.message)); });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickNav = (label) => evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('${label}'));
  b?.click(); return !!b;
})()`);

// Wait for app ready (vault loaded from persisted config -> file tree)
let ready = false;
for (let i = 0; i < 15; i++) {
  await sleep(1000);
  const t = await evalJs(`(() => JSON.stringify([...document.querySelectorAll('.tree-name')].map(x => x.textContent)))()`);
  if (t && t !== "[]") { ready = true; console.log("[ready] file tree:", t); break; }
}
if (!ready) { console.log("[ready] TIMEOUT — app not ready"); }

// Notes: open 示例笔记.md
await evalJs(`(() => {
  const n = [...document.querySelectorAll('.tree-name')].find(x => x.textContent.includes('示例笔记'));
  n?.closest('.tree-row')?.click(); return 'ok';
})()`);
await sleep(2000);
console.log("[notes] active:", await evalJs(`document.querySelector('.editor-title')?.textContent`));
console.log("[notes] vditor IR:", await evalJs(`!!document.querySelector('.vditor-ir')`));

// Backlinks
const back = await evalJs(`(async () => {
  const bar = document.querySelector('.backlinks-toggle');
  if (!bar) return 'NO_BAR';
  bar.click(); await new Promise(r => setTimeout(r, 300));
  return JSON.stringify([...document.querySelectorAll('.backlink-item')].map(b => b.textContent.trim()));
})()`);
console.log("[backlinks]", back);

// Checklists
await clickNav("清单");
await sleep(1000);
console.log("[checklists]", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.checklist-row-title')].map(x => x.textContent)
))()`));

// Records
await clickNav("记录");
await sleep(1000);
console.log("[records]", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.record-row-title')].map(x => x.textContent)
))()`));

// Plugins + real python invoke
await clickNav("插件");
await sleep(1500);
console.log("[plugins]", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.plugin-card')].map(c => ({
    t: c.querySelector('.plugin-title h2')?.textContent,
    s: c.querySelector('.badge-status')?.textContent.trim()
  }))
))()`));
const conv = await evalJs(`(async () => {
  const card = [...document.querySelectorAll('.plugin-card')].find(c => c.textContent.includes('CSV'));
  const tryBtn = card?.querySelector('.command-try');
  if (!tryBtn) return 'NO_TRY';
  tryBtn.click(); await new Promise(r => setTimeout(r, 300));
  const btn = [...card.querySelectorAll('.try-head .btn')].find(b => b.textContent.includes('运行'));
  btn?.click(); await new Promise(r => setTimeout(r, 1500));
  return card.querySelector('.try-result')?.textContent ?? 'NO_RESULT';
})()`);
console.log("[plugins] csv.convert:", conv);

console.log("--- errors (this session) ---");
let n = 0;
for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") {
    n++; console.log("[exception]", ev.params.exceptionDetails.exception?.description?.split("\n").slice(0,5).join(" | "));
  }
  if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
    const t = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { n++; console.log("[console.error]", t.split("\n")[0].slice(0, 120)); }
  }
}
console.log(`real errors: ${n}`);
ws.close();
console.log("=== CLEAN E2E DONE ===");
process.exit(0);
