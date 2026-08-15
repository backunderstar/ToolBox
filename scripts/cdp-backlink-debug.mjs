// Debug: why backlinks bar not showing in real app.
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

// 1. Records view state
await clickNav("记录");
await sleep(800);
console.log("[1] record rows:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.record-row-title')].map(x => x.textContent)
))()`));

// open the record, check its links
await evalJs(`(() => { document.querySelector('.record-row')?.click(); return 'ok'; })()`);
await sleep(600);
console.log("[1] record links in editor:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.record-links .note-link')].map(n => n.textContent.trim())
))()`));

// 2. Back to notes, open note, inspect backlinks area
await clickNav("笔记");
await sleep(800);
await evalJs(`(() => {
  const n = [...document.querySelectorAll('.tree-name')].find(x => x.textContent.includes('示例笔记'));
  n?.closest('.tree-row')?.click(); return 'ok';
})()`);
await sleep(2000);
console.log("[2] editor title:", await evalJs(`document.querySelector('.editor-title')?.textContent`));
console.log("[2] backlinks toggle exists:", await evalJs(`!!document.querySelector('.backlinks-toggle')`));
console.log("[2] body contains 反向链接:", await evalJs(`document.body.textContent.includes('反向链接')`));
console.log("[2] body contains 真实运行验证记录:", await evalJs(`document.body.textContent.includes('真实运行验证记录')`));

console.log("--- errors ---");
for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") {
    console.log("[exception]", ev.params.exceptionDetails.exception?.description?.split("\n").slice(0,6).join("\n   "));
  }
  if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
    console.log("[console.error]", ev.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
}
ws.close();
process.exit(0);
