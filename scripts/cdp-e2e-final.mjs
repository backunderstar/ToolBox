// Final E2E verification after fs_list_dir fix (fresh page load).
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url));
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

// Fresh reload to clear HMR residue
await evalJs(`location.reload()`);
await sleep(4000);

// 1. Checklists list + open
await clickNav("清单");
await sleep(1000);
console.log("[1] checklist metas:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.checklist-row-title')].map(x => x.textContent)
))()`));
await evalJs(`(() => { document.querySelector('.checklist-row')?.click(); return 'ok'; })()`);
await sleep(600);
console.log("[1] editor:", await evalJs(`(() => JSON.stringify({
  title: document.querySelector('.checklist-title-input')?.value,
  items: [...document.querySelectorAll('.checklist-item-text')].map(i => i.value),
  progress: document.querySelector('.checklist-progress-text')?.textContent
}))()`));

// 2. Records list + backlinks
await clickNav("记录");
await sleep(1000);
console.log("[2] records:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.record-row-title')].map(x => x.textContent)
))()`));

await clickNav("笔记");
await sleep(800);
await evalJs(`(() => {
  const n = [...document.querySelectorAll('.tree-name')].find(x => x.textContent.includes('示例笔记'));
  n?.closest('.tree-row')?.click(); return 'ok';
})()`);
await sleep(2000);
const back = await evalJs(`(async () => {
  const bar = document.querySelector('.backlinks-toggle');
  if (!bar) return 'NO_BAR';
  bar.click();
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify([...document.querySelectorAll('.backlink-item')].map(b => b.textContent.trim()));
})()`);
console.log("[2] backlinks:", back);

// 3. Plugins still healthy
await clickNav("插件");
await sleep(1200);
console.log("[3] plugins:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.plugin-card')].map(c => ({
    title: c.querySelector('.plugin-title h2')?.textContent,
    status: c.querySelector('.badge-status')?.textContent.trim()
  }))
))()`));

console.log("--- errors ---");
let n = 0;
for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") { n++; console.log("[exception]", ev.params.exceptionDetails.exception?.description?.split("\n").slice(0,4).join(" | ")); }
  if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
    const t = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { n++; console.log("[console.error]", t.split("\n")[0]); }
  }
}
console.log(`real errors: ${n}`);
ws.close();
console.log("=== FINAL E2E DONE ===");
process.exit(0);
