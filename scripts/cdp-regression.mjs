// Regression E2E after audit fixes (real WebView2):
// fs_delete guard, backlinks derivation, blog content source, plugin perms, AI degrade.
const PORT = process.argv[2] ?? "9226";
const V = "D:\\\\WORKSPACE\\\\ToolBox\\\\src-tauri\\\\target\\\\e2e-vault";

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
  if (r.result?.exceptionDetails) return "EXC: " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickNav = (label) => evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('${label}'));
  b?.click(); return !!b;
})()`);
const inv = (cmd, args) =>
  evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(r => JSON.stringify({ ok: true, r })).catch(e => JSON.stringify({ ok: false, e: String(e) }))`);

// 0. vault
await inv("vault_set", { path: "D:\\WORKSPACE\\ToolBox\\src-tauri\\target\\e2e-vault" });

// 1. fs_delete guard: empty / "." must be rejected (vault must survive)
console.log("[1] fs_delete empty:", await inv("fs_delete", { vault: V, rel: "" }));
console.log("[1] fs_delete dot:", await inv("fs_delete", { vault: V, rel: "." }));

// 2. Backlinks derivation: create record with [[示例笔记.md]], open note -> immediate backlink
await clickNav("记录");
await sleep(800);
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.records-pane-actions .btn')].find(x => x.textContent.includes('新建'));
  b?.click(); return 'ok';
})()`);
await sleep(500);
const recEdit = await evalJs(`(async () => {
  const setTA = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const setI = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  const t = document.querySelector('.record-title-input');
  const c = document.querySelector('.record-content-input');
  setI(t, '反链验证记录');
  setTA(c, '引用 [[示例笔记.md]] 的记录');
  await new Promise(r => setTimeout(r, 1200)); // autosave
  return 'SAVED';
})()`);
console.log("[2] record saved:", recEdit);
await clickNav("笔记");
await sleep(800);
await evalJs(`(() => {
  const n = [...document.querySelectorAll('.tree-name')].find(x => x.textContent.includes('示例笔记'));
  n?.closest('.tree-row')?.click(); return 'ok';
})()`);
await sleep(1500);
const backlinks = await evalJs(`(async () => {
  const bar = document.querySelector('.backlinks-toggle');
  if (!bar) return 'NO_BAR';
  bar.click(); await new Promise(r => setTimeout(r, 300));
  return JSON.stringify([...document.querySelectorAll('.backlink-item')].map(b => b.textContent.trim()));
})()`);
console.log("[2] backlinks (derived):", backlinks);

// 3. Blog: generate, check content source = original (no duplicated body)
await clickNav("博客发布");
await sleep(900);
const gen = await evalJs(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('生成站点'));
  btn?.click();
  await new Promise(r => setTimeout(r, 1200));
  return document.querySelector('.blog-site-card .settings-message')?.textContent ?? 'NO_MSG';
})()`);
console.log("[3] generate:", JSON.stringify(gen));

// 4. Plugins: csv-tool enable + real python invoke (permissions declared)
await clickNav("插件");
await sleep(1000);
const enable = await evalJs(`(async () => {
  const card = [...document.querySelectorAll('.plugin-card')].find(c => c.textContent.includes('CSV'));
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent === '启用');
  if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
  return [...card.querySelectorAll('.badge-status')].map(b => b.textContent.trim()).join(',');
})()`);
console.log("[4] csv enabled:", enable);
const conv = await evalJs(`(async () => {
  const card = [...document.querySelectorAll('.plugin-card')].find(c => c.textContent.includes('CSV'));
  card.querySelector('.command-try')?.click();
  await new Promise(r => setTimeout(r, 300));
  const btn = [...card.querySelectorAll('.try-head .btn')].find(b => b.textContent.includes('运行'));
  btn?.click();
  await new Promise(r => setTimeout(r, 1500));
  return card.querySelector('.try-result')?.textContent?.slice(0, 60) ?? 'NO_RESULT';
})()`);
console.log("[4] csv.convert:", JSON.stringify(conv));

// 5. AI degrade
await clickNav("AI 整理");
await sleep(600);
const ai = await evalJs(`(async () => {
  const input = document.querySelector('.ai-chat-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'hi');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  [...document.querySelectorAll('.ai-input-row .btn-primary-ai')][0]?.click();
  await new Promise(r => setTimeout(r, 1000));
  const msgs = [...document.querySelectorAll('.ai-msg .ai-msg-content')];
  return JSON.stringify({ count: msgs.length, last: msgs.at(-1)?.textContent?.slice(0, 40) ?? '' });
})()`);
console.log("[5] ai no-key:", ai);

console.log("--- errors ---");
let n = 0;
for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") { n++; console.log("[exception]", ev.params.exceptionDetails.exception?.description?.split("\n").slice(0,4).join(" | ")); }
  if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
    const t = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    if (!t.includes("failed-resources")) { n++; console.log("[console.error]", t.split("\n")[0].slice(0,110)); }
  }
}
console.log(`real errors: ${n}`);
ws.close();
console.log("=== REGRESSION DONE ===");
process.exit(0);
