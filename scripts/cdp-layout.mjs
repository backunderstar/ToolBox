// CDP layout interaction test: toggle nav/files/focus, measure widths.
const PORT = process.argv[2] ?? "9224";
const URL = process.argv[3] ?? "http://localhost:1420/?mock=1";

const target = await fetch(
  `http://localhost:${PORT}/json/new?` + encodeURIComponent(URL),
  { method: "PUT" }
).then((r) => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 4000));

// 清空布局偏好并重载，保证从干净状态开始
await send("Runtime.evaluate", { expression: `localStorage.removeItem('toolbox.layout')`, returnByValue: true });
await send("Page.enable", {});
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 9000));

const helper = `
  window.__m = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width) : null; };
  window.__click = (sel) => { const el = document.querySelector(sel); if (el) { el.click(); return true; } return false; };
`;
await send("Runtime.evaluate", { expression: helper, returnByValue: true });

const measure = `JSON.stringify({
  sidebar: __m('.sidebar'),
  files: __m('.files-pane'),
  editor: __m('.editor-area'),
  notes: __m('.notes')
})`;

const step = async (label) => {
  const r = await send("Runtime.evaluate", { expression: measure, returnByValue: true });
  console.log(label, r.result.result.value);
  await new Promise((res) => setTimeout(res, 500));
};

await step("INITIAL       :");
const navToggle = await send("Runtime.evaluate", {
  expression: `__click('.topbar .icon-btn')`,
  returnByValue: true,
});
await step("NAV COLLAPSED  :");

// debug: what buttons exist in files-header and editor-header
const dbg = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    filesButtons: [...document.querySelectorAll('.files-header button')].map(b => b.title),
    editorButtons: [...document.querySelectorAll('.editor-header button')].map(b => b.title),
    filesCollapsed: !!document.querySelector('.files-pane.collapsed'),
  })`,
  returnByValue: true,
});
console.log("DEBUG          :", dbg.result.result.value);

await send("Runtime.evaluate", {
  expression: `__click('.files-header button[title="收起文件面板"]')`,
  returnByValue: true,
});
await step("FILES COLLAPSED:");

await send("Runtime.evaluate", {
  expression: `__click('.editor-header button[title^="专注模式"]')`,
  returnByValue: true,
});
await step("FOCUS MODE     :");

// persistence check: reload and verify prefs restored
await send("Runtime.evaluate", { expression: `localStorage.getItem('toolbox.layout')`, returnByValue: true }).then((r) => {
  console.log("saved prefs    :", r.result.result.value);
});
ws.close();
process.exit(0);
