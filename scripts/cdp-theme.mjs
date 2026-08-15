// CDP smoke test for M5 theme system (mock mode).
// Usage: node scripts/cdp-theme.mjs [port] [waitSec]
const PORT = process.argv[2] ?? "9225";
const URL = "http://localhost:1420/?mock=1";
const WAIT_SEC = Number(process.argv[3] ?? 5);

const target = await fetch(
  `http://localhost:${PORT}/json/new?` + encodeURIComponent(URL),
  { method: "PUT" }
).then((r) => r.json());

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("WS error: " + e.message)); });
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

console.log(`[theme-test] waiting ${WAIT_SEC}s...`);
await sleep(WAIT_SEC * 1000);

// 1. Open settings
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('设置'));
  b?.click(); return 'ok';
})()`);
await sleep(600);
console.log("[1] theme cards:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.theme-card-name')].map(x => x.textContent)
))()`));

// 2. Select warm theme
await evalJs(`(() => {
  const c = [...document.querySelectorAll('.theme-card')].find(x => x.textContent.includes('暖色'));
  c?.click(); return 'ok';
})()`);
await sleep(400);
console.log("[2] warm:", await evalJs(`(() => JSON.stringify({
  themeId: document.documentElement.dataset.themeId,
  base: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  stored: localStorage.getItem('toolbox.theme')
}))()`));

// 3. Dark theme
await evalJs(`(() => {
  const c = [...document.querySelectorAll('.theme-card')].find(x => x.textContent.includes('简约暗色'));
  c?.click(); return 'ok';
})()`);
await sleep(400);
console.log("[3] dark:", await evalJs(`(() => JSON.stringify({
  themeId: document.documentElement.dataset.themeId,
  base: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
}))()`));

// 4. New theme from current -> editor -> recolor -> save
await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('基于当前主题新建'));
  b?.click(); return 'ok';
})()`);
await sleep(400);
console.log("[4] editor open:", await evalJs(`(() => JSON.stringify({
  editor: !!document.querySelector('.theme-editor'),
  tokenRows: document.querySelectorAll('.theme-token-row').length
}))()`));
// set name + accent color
const edited = await evalJs(`(async () => {
  const setInput = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const name = document.querySelector('.theme-editor-name');
  setInput(name, '我的主题');
  const accent = [...document.querySelectorAll('.theme-token-row')].find(r => r.textContent.includes('--accent'))?.querySelector('input[type=color]');
  if (accent) { setInput(accent, '#3366ff'); }
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify({
    previewAccent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    previewThemeId: document.documentElement.dataset.themeId
  });
})()`);
console.log("[4] live preview:", edited);
// save
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.theme-editor-actions button')].find(x => x.textContent.includes('保存'));
  b?.click(); return 'ok';
})()`);
await sleep(400);
console.log("[4] saved:", await evalJs(`(() => JSON.stringify({
  cards: [...document.querySelectorAll('.theme-card-name')].map(x => x.textContent),
  active: document.querySelector('.theme-card.active .theme-card-name')?.textContent,
  themeId: document.documentElement.dataset.themeId,
  stored: localStorage.getItem('toolbox.theme'),
  custom: localStorage.getItem('toolbox.custom-themes')
}))()`));

// 5. Delete custom theme (override confirm BEFORE clicking, headless modal blocks otherwise)
await evalJs(`window.confirm = () => true; 'ok'`);
await evalJs(`(() => {
  const c = [...document.querySelectorAll('.theme-card')].find(x => x.textContent.includes('我的主题'));
  c?.querySelector('.theme-delete')?.click(); return 'ok';
})()`);
await sleep(400);
console.log("[5] after delete:", await evalJs(`(() => JSON.stringify({
  cards: [...document.querySelectorAll('.theme-card-name')].map(x => x.textContent),
  themeId: document.documentElement.dataset.themeId
}))()`));

// 6. Topbar toggle light<->dark
await evalJs(`(() => {
  const b = document.querySelector('.topbar .icon-btn:last-child');
  b?.click(); return 'ok';
})()`);
await sleep(300);
console.log("[6] after toggle:", await evalJs(`(() => JSON.stringify({
  themeId: document.documentElement.dataset.themeId,
  base: document.documentElement.dataset.theme
}))()`));

console.log("--- errors ---");
let n = 0;
for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") { n++; console.log("[exception]", ev.params.exceptionDetails.exception?.description?.split("\n").slice(0,4).join(" | ")); }
  if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
    const t = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { n++; console.log("[console.error]", t.split("\n")[0].slice(0,120)); }
  }
}
console.log(`real errors: ${n}`);
ws.close();
console.log("=== THEME TEST DONE ===");
process.exit(0);
