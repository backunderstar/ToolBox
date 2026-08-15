// CDP smoke test for the Settings view (mock mode).
// Usage: node scripts/cdp-settings.mjs [port] [waitSec]
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
console.log(`[settings-test] waiting ${WAIT_SEC}s for app init...`);
await new Promise((r) => setTimeout(r, WAIT_SEC * 1000));

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

// 1. Click the 设置 nav item
const navRes = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('设置'));
  if (!b) return 'NO_NAV';
  b.click();
  return 'CLICKED';
})()`);
console.log("[1] nav click:", navRes);
await new Promise((r) => setTimeout(r, 600));

// 2. Read settings view state
const view = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.settings-card')].map(c => ({
    title: c.querySelector('.settings-title')?.textContent ?? '',
    rows: [...c.querySelectorAll('.settings-row')].map(r => r.textContent.trim().replace(/\\s+/g, ' '))
  }));
  return JSON.stringify({
    header: document.querySelector('.view-header h1')?.textContent ?? '',
    cards,
    path: document.querySelector('.settings-path')?.textContent ?? null,
    theme: document.documentElement.dataset.theme
  });
})()`);
console.log("[2] settings view:", view);

// 3. Switch theme to dark via segmented control
const darkRes = await evalJs(`(async () => {
  const dark = [...document.querySelectorAll('.segmented-item')].find(b => b.textContent.includes('暗色'));
  if (!dark) return 'NO_DARK_BTN';
  dark.click();
  await new Promise(r => setTimeout(r, 300));
  return document.documentElement.dataset.theme + '|' + localStorage.getItem('toolbox.theme');
})()`);
console.log("[3] switch dark:", darkRes);

// 4. Switch back to light
const lightRes = await evalJs(`(async () => {
  const light = [...document.querySelectorAll('.segmented-item')].find(b => b.textContent.includes('亮色'));
  if (!light) return 'NO_LIGHT_BTN';
  light.click();
  await new Promise(r => setTimeout(r, 300));
  return document.documentElement.dataset.theme + '|' + localStorage.getItem('toolbox.theme');
})()`);
console.log("[4] switch light:", lightRes);

// 5. Workspace section buttons present?
const wsBtns = await evalJs(`(() => {
  const card = [...document.querySelectorAll('.settings-card')].find(c => c.textContent.includes('工作区'));
  return JSON.stringify(card ? [...card.querySelectorAll('button')].map(b => b.textContent.trim()) : 'NO_CARD');
})()`);
console.log("[5] workspace buttons:", wsBtns);

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
