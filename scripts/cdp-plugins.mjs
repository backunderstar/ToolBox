// CDP smoke test for the Plugins view (mock mode).
// Usage: node scripts/cdp-plugins.mjs [port] [waitSec]
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
console.log(`[plugins-test] waiting ${WAIT_SEC}s for app init...`);
await new Promise((r) => setTimeout(r, WAIT_SEC * 1000));

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

// 1. Click the 插件 nav item
const navRes = await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.nav-item')];
  const target = btns.find(b => b.textContent.includes('插件'));
  if (!target) return 'NO_NAV';
  target.click();
  return 'CLICKED';
})()`);
console.log("[1] nav click:", navRes);
await new Promise((r) => setTimeout(r, 800));

// 2. Read plugin cards
const cards = await evalJs(`(() => {
  const cs = [...document.querySelectorAll('.plugin-card')];
  return JSON.stringify(cs.map(c => ({
    title: c.querySelector('.plugin-title h2')?.textContent ?? '',
    badges: [...c.querySelectorAll('.plugin-title .badge')].map(b => b.textContent.trim()),
    desc: c.querySelector('.plugin-desc')?.textContent ?? '',
    commands: [...c.querySelectorAll('.command-name')].map(x => x.textContent),
    hasError: !!c.querySelector('.plugin-error')
  })));
})()`);
console.log("[2] plugin cards:", cards);

// 3. Click first command's 试用 (text-stats analyze)
const tryRes = await evalJs(`(() => {
  const b = document.querySelector('.command-try');
  if (!b) return 'NO_TRY_BTN';
  b.click();
  return 'OPENED';
})()`);
console.log("[3] try panel:", tryRes);
await new Promise((r) => setTimeout(r, 400));

// 4. Fill args and run
const runRes = await evalJs(`(async () => {
  const ta = document.querySelector('.try-args');
  if (!ta) return 'NO_ARGS';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, JSON.stringify({ text: '你好世界\\n第二行\\n\\n新段' }));
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const btn = [...document.querySelectorAll('.try-head .btn')].find(b => b.textContent.includes('运行'));
  if (!btn) return 'NO_RUN_BTN';
  btn.click();
  await new Promise(r => setTimeout(r, 600));
  const res = document.querySelector('.try-result');
  return res ? res.textContent : 'NO_RESULT_YET';
})()`);
console.log("[4] analyze result:", runRes);

// 5. Switch to csv-tool card try (process plugin, mock impl)
const csvRes = await evalJs(`(async () => {
  const cards = [...document.querySelectorAll('.plugin-card')];
  const csv = cards.find(c => c.textContent.includes('CSV'));
  if (!csv) return 'NO_CSV_CARD';
  const tryBtn = [...csv.querySelectorAll('.command-try')][0];
  if (!tryBtn) return 'NO_CSV_TRY';
  tryBtn.click();
  await new Promise(r => setTimeout(r, 400));
  const ta = csv.querySelector('.try-args');
  if (!ta) return 'NO_CSV_ARGS';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, JSON.stringify({ csv: '名称,数量\\n苹果,3\\n香蕉,5', format: 'json' }));
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const btn = [...csv.querySelectorAll('.try-head .btn')].find(b => b.textContent.includes('运行'));
  if (!btn) return 'NO_RUN_BTN';
  btn.click();
  await new Promise(r => setTimeout(r, 600));
  const res = csv.querySelector('.try-result');
  return res ? res.textContent : 'NO_RESULT_YET';
})()`);
console.log("[5] csv convert result:", csvRes);

console.log("--- CONSOLE / ERRORS ---");
let errCount = 0;
for (const ev of events) {
  if (ev.method === "Runtime.consoleAPICalled") {
    const args = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (ev.params.type === "error" || ev.params.type === "warning") {
      errCount++;
      console.log(`[${ev.params.type}]`, args);
    }
  }
  if (ev.method === "Runtime.exceptionThrown") {
    errCount++;
    const d = ev.params.exceptionDetails;
    console.log("[exception]", d.text, "@", d.url ?? "", "line", d.lineNumber, "col", d.columnNumber);
    if (d.exception?.description) console.log("  ", d.exception.description.split("\n").slice(0, 6).join("\n   "));
  }
}
console.log(`errors/warnings captured: ${errCount}`);
ws.close();
console.log("=== DONE ===");
process.exit(0);
