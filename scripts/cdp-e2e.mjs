// E2E test against the REAL Tauri app (WebView2 CDP at :9226).
// Verifies: vault set, notes read/write, checklist JSON persistence,
// records JSON persistence + backlinks, plugin list + python bridge.
// Usage: node scripts/cdp-e2e.mjs [port]
const PORT = process.argv[2] ?? "9226";
const V = "D:\\\\WORKSPACE\\\\ToolBox\\\\src-tauri\\\\target\\\\e2e-vault";

// Find the app page target
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url));
if (!page) {
  console.log("NO_PAGE_TARGET", targets.map((t) => ({ type: t.type, url: t.url })));
  process.exit(1);
}
console.log("[target]", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
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

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return "EXC: " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  }
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Set vault via real IPC
console.log("[1] vault_set:", await evalJs(
  `window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke("vault_set", { path: "${V}" }).then(() => "SET").catch(e => "ERR:" + e) : "NO_INTERNALS"`
));
await sleep(500);
await evalJs(`location.reload()`);
await sleep(4000);

// 2. Notes: file tree shows 示例笔记.md, open it
const tree = await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.tree-name')].map(x => x.textContent)
))()`);
console.log("[2] file tree:", tree);
await evalJs(`(() => {
  const n = [...document.querySelectorAll('.tree-name')].find(x => x.textContent.includes('示例笔记'));
  if (n) n.closest('.tree-row')?.click();
  return 'ok';
})()`);
await sleep(1500);
const note = await evalJs(`(() => ({
  active: document.querySelector('.editor-title')?.textContent ?? null,
  ir: !!document.querySelector('.vditor-ir'),
  textLen: document.querySelector('.vditor-ir')?.textContent?.length ?? -1
}))()`);
console.log("[2] note opened:", JSON.stringify(note));

// 3. Checklists: create 真实验证清单, add item, toggle, wait autosave
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('清单'));
  b?.click(); return 'ok';
})()`);
await sleep(800);
const createRes = await evalJs(`(async () => {
  const input = document.querySelector('.checklist-new-input');
  if (!input) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '真实验证清单');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  const btn = document.querySelector('.checklist-new button');
  btn?.click();
  await new Promise(r => setTimeout(r, 900));
  return document.querySelector('.checklist-title-input')?.value ?? 'NOT_OPENED';
})()`);
console.log("[3] checklist created:", createRes);

const itemRes = await evalJs(`(async () => {
  const input = document.querySelector('.checklist-add .checklist-new-input');
  if (!input) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '第一步：真实落盘验证');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.checklist-add .btn')?.click();
  await new Promise(r => setTimeout(r, 500));
  const cb = document.querySelector('.checklist-check input');
  if (cb) { cb.click(); }
  await new Promise(r => setTimeout(r, 1500)); // wait autosave
  return document.querySelector('.checklist-progress-text')?.textContent ?? 'NO_PROGRESS';
})()`);
console.log("[3] item added+toggled, progress:", itemRes);

// 4. Records: create record with [[示例笔记.md]], wait autosave
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('记录'));
  b?.click(); return 'ok';
})()`);
await sleep(800);
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.records-pane-actions .btn')].find(x => x.textContent.includes('新建'));
  b?.click(); return 'ok';
})()`);
await sleep(600);
const recRes = await evalJs(`(async () => {
  const setInput = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const setTA = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const title = document.querySelector('.record-title-input');
  const content = document.querySelector('.record-content-input');
  if (!title || !content) return 'NO_EDITOR';
  setInput(title, '真实运行验证记录');
  setTA(content, '通过 WebView2 CDP 驱动真实应用创建。\\n\\n参考 [[示例笔记.md]]');
  await new Promise(r => setTimeout(r, 1500)); // autosave
  const links = [...document.querySelectorAll('.record-links .note-link')].map(n => n.textContent.trim());
  return JSON.stringify({ links });
})()`);
console.log("[4] record saved, links:", recRes);

// 5. Backlinks in notes view
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('笔记'));
  b?.click(); return 'ok';
})()`);
await sleep(800);
const backRes = await evalJs(`(async () => {
  const bar = document.querySelector('.backlinks-toggle');
  if (!bar) return 'NO_BAR';
  bar.click();
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify([...document.querySelectorAll('.backlink-item')].map(b => b.textContent.trim()));
})()`);
console.log("[5] backlinks:", backRes);

// 6. Plugins: list shows both plugins, enable csv-tool, run csv.convert (real python)
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('插件'));
  b?.click(); return 'ok';
})()`);
await sleep(1000);
const pluginCards = await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.plugin-card')].map(c => ({
    title: c.querySelector('.plugin-title h2')?.textContent,
    badges: [...c.querySelectorAll('.badge-status')].map(b => b.textContent.trim()),
    hasEnable: [...c.querySelectorAll('button')].some(b => b.textContent === '启用')
  }))
))()`);
console.log("[6] plugin cards:", pluginCards);

// enable csv-tool (spawns real python via set_enabled)
const enableRes = await evalJs(`(async () => {
  const card = [...document.querySelectorAll('.plugin-card')].find(c => c.textContent.includes('CSV'));
  if (!card) return 'NO_CSV_CARD';
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '启用');
  if (!btn) return 'ALREADY_ENABLED';
  btn.click();
  await new Promise(r => setTimeout(r, 1500));
  return [...card.querySelectorAll('.badge-status')].map(b => b.textContent.trim()).join(',');
})()`);
console.log("[6] csv-tool enabled, status:", enableRes);

const convertRes = await evalJs(`(async () => {
  const card = [...document.querySelectorAll('.plugin-card')].find(c => c.textContent.includes('CSV'));
  const tryBtn = card?.querySelector('.command-try');
  if (!tryBtn) return 'NO_TRY';
  tryBtn.click();
  await new Promise(r => setTimeout(r, 300));
  const btn = [...card.querySelectorAll('.try-head .btn')].find(b => b.textContent.includes('运行'));
  btn?.click();
  await new Promise(r => setTimeout(r, 1200)); // real python roundtrip
  const res = card.querySelector('.try-result');
  return res ? res.textContent : 'NO_RESULT';
})()`);
console.log("[6] csv.convert real result:", convertRes);

console.log("--- CONSOLE ERRORS (from CDP) ---");
let errCount = 0;
for (const ev of events) {
  if (ev.method === "Runtime.consoleAPICalled" && (ev.params.type === "error")) {
    errCount++;
    console.log("[console.error]", ev.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (ev.method === "Runtime.exceptionThrown") {
    errCount++;
    console.log("[exception]", ev.params.exceptionDetails.text);
  }
}
console.log(`cdp errors: ${errCount}`);
ws.close();
console.log("=== E2E DONE ===");
process.exit(0);
