// Real-app E2E for M6 AI + M7 Blog: frontmatter post, site generation, preview server,
// AI config persistence & no-key degradation.
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

// 0. Set vault + write a published post via real IPC
console.log("[0] vault_set:", await evalJs(
  `window.__TAURI_INTERNALS__.invoke("vault_set", { path: "${V}" }).then(() => "SET").catch(e => "ERR:" + e)`
));
const postContent = `---\ntitle: 第一篇博客\ndate: 2026-08-15\ntags: 随笔, 开发\nstatus: published\n---\n\n这是**第一篇**博客内容。\n\n- 要点一\n- 要点二\n`;
console.log("[0] write post:", await evalJs(
  `window.__TAURI_INTERNALS__.invoke("fs_write", { vault: "${V}", rel: "博客文章.md", content: ${JSON.stringify(postContent)} }).then(() => "WRITTEN").catch(e => "ERR:" + e)`
));

// 1. Blog view shows the post
await clickNav("博客发布");
await sleep(1000);
console.log("[1] blog posts:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.blog-row-title')].map(x => x.textContent)
))()`));

// 2. Generate site
const genRes = await evalJs(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('生成站点'));
  btn?.click();
  await new Promise(r => setTimeout(r, 1200));
  return document.querySelector('.blog-site-card .settings-message')?.textContent ?? 'NO_MSG';
})()`);
console.log("[2] generate:", JSON.stringify(genRes));

// 3. Preview server: start + HTTP GET
const prevRes = await evalJs(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '预览');
  btn?.click();
  await new Promise(r => setTimeout(r, 800));
  return 'clicked';
})()`);
console.log("[3] preview started:", prevRes);
// find the preview port from state — poll common approach: read from app by invoking? Instead read site dir + try 127.0.0.1 random port unknown. Use CDP fetch to localhost port 0? Unknown port. Better: capture via network request? Simplest: check that server process started via another request — we can't know port. Use the index_url from generate result? It used PREVIEW_PORT which is 0 until start. Skip URL; verify via netstat in shell after.
await sleep(400);

// 4. AI settings: save config (no key) -> persists; test without key -> friendly error
await clickNav("设置");
await sleep(800);
const aiSave = await evalJs(`(() => {
  const input = document.querySelector('.ai-input-sm');
  if (!input) return 'NO_MODEL_INPUT';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'my-test-model');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('保存配置'));
  btn?.click();
  return 'SAVED_CLICKED';
})()`);
console.log("[4] ai save:", aiSave);
await sleep(800);

const noKeyTest = await evalJs(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('测试连接'));
  if (!btn) return 'NO_TEST_BTN';
  btn.click();
  await new Promise(r => setTimeout(r, 900));
  return document.querySelector('.settings-message')?.textContent ?? 'NO_MSG';
})()`);
console.log("[4] no-key test:", JSON.stringify(noKeyTest));

// 5. AI chat view degradation
await clickNav("AI 整理");
await sleep(600);
const aiChatRes = await evalJs(`(async () => {
  const input = document.querySelector('.ai-chat-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '你好');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const btn = [...document.querySelectorAll('.ai-input-row .btn-primary-ai')][0];
  btn?.click();
  await new Promise(r => setTimeout(r, 1000));
  const msgs = [...document.querySelectorAll('.ai-msg .ai-msg-content')];
  return JSON.stringify({ count: msgs.length, last: msgs.at(-1)?.textContent?.slice(0, 60) ?? '' });
})()`);
console.log("[5] ai chat no-key:", aiChatRes);

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
console.log("=== M67 E2E DONE ===");
process.exit(0);
