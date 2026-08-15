// CDP smoke test for the Tools view (mock mode).
// Usage: node scripts/cdp-tools.mjs [port] [waitSec]
const PORT = process.argv[2] ?? "9225";
const URL = "http://localhost:1420/?mock=1";
const WAIT_SEC = Number(process.argv[3] ?? 5);

const target = await fetch(
  `http://localhost:${PORT}/json/new?` + encodeURIComponent(URL),
  { method: "PUT" }
).then((r) => r.json());

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = (e) => rej(new Error("WS error: " + e.message));
});
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      cb(m);
    }
  } else if (m.method) {
    events.push(m);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send("Runtime.enable");
await send("Log.enable");
console.log(`[tools-test] waiting ${WAIT_SEC}s...`);
await new Promise((r) => setTimeout(r, WAIT_SEC * 1000));

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Click 数据工具 nav
console.log("[1]", await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('数据工具'));
  if (!b) return 'NO_NAV';
  b.click(); return 'CLICKED';
})()`));
await sleep(600);

// 2. Built-in tool cards
console.log("[2] tool cards:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.tool-card')].map(c => c.querySelector('.tool-card-name')?.textContent)
))()`));

// 3. Open JSON tool, type invalid then valid
console.log("[3]", await evalJs(`(() => {
  const c = [...document.querySelectorAll('.tool-card')].find(x => x.textContent.includes('JSON'));
  if (!c) return 'NO_CARD'; c.click(); return 'OPENED';
})()`));
await sleep(400);
const jsonRes = await evalJs(`(async () => {
  const ta = document.querySelector('.tool-input');
  if (!ta) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '{"a":1,"b":[true,null,"x"]}');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const out = document.querySelector('.tool-result');
  return out ? out.textContent : 'NO_OUTPUT';
})()`);
console.log("[3] json format:", JSON.stringify(jsonRes));

// 4. Back, open timestamp tool
console.log("[4]", await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('全部工具'));
  if (!b) return 'NO_BACK'; b.click(); return 'BACK';
})()`));
await sleep(400);
console.log("[4]", await evalJs(`(() => {
  const c = [...document.querySelectorAll('.tool-card')].find(x => x.textContent.includes('时间戳'));
  if (!c) return 'NO_CARD'; c.click(); return 'OPENED_TS';
})()`));
await sleep(400);
const tsRes = await evalJs(`(async () => {
  const inp = document.querySelector('.tool-input-single');
  if (!inp) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(inp, '1735689600');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify([...document.querySelectorAll('.ts-row')].map(r => r.textContent.trim()));
})()`);
console.log("[4] timestamp rows:", tsRes);

// 5. Back, plugin commands section
console.log("[5]", await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('全部工具'));
  if (!b) return 'NO_BACK'; b.click(); return 'BACK';
})()`));
await sleep(400);
console.log("[5] plugin section:", await evalJs(`(() => JSON.stringify({
  hasStats: document.body.textContent.includes('文本统计'),
  hasCsv: document.body.textContent.includes('CSV 工具'),
  chips: [...document.querySelectorAll('.tools-plugins .command-name')].map(x => x.textContent)
}))()`));

// 6. Run csv.convert from tools view
const csvRes = await evalJs(`(async () => {
  const csvCard = [...document.querySelectorAll('.tools-plugins .plugin-card')].find(c => c.textContent.includes('CSV'));
  if (!csvCard) return 'NO_CSV_CARD';
  const tryBtn = [...csvCard.querySelectorAll('.command-try')][0];
  if (!tryBtn) return 'NO_TRY';
  tryBtn.click();
  await new Promise(r => setTimeout(r, 300));
  const btn = [...document.querySelectorAll('.tools-plugins .try-head .btn')].find(b => b.textContent.includes('运行'));
  if (!btn) return 'NO_RUN';
  btn.click();
  await new Promise(r => setTimeout(r, 500));
  const res = document.querySelector('.tools-plugins .try-result');
  return res ? res.textContent : 'NO_RESULT';
})()`);
console.log("[6] csv.convert:", csvRes);

console.log("--- CONSOLE / ERRORS ---");
let errCount = 0;
for (const ev of events) {
  if (ev.method === "Runtime.consoleAPICalled" && (ev.params.type === "error" || ev.params.type === "warning")) {
    errCount++;
    console.log(`[${ev.params.type}]`, ev.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (ev.method === "Runtime.exceptionThrown") {
    errCount++;
    const d = ev.params.exceptionDetails;
    console.log("[exception]", d.text, "@", d.url ?? "", "line", d.lineNumber);
    if (d.exception?.description) console.log("  ", d.exception.description.split("\n").slice(0, 6).join("\n   "));
  }
}
console.log(`errors/warnings captured: ${errCount}`);
ws.close();
console.log("=== DONE ===");
process.exit(0);
