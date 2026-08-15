// Re-verify blog after css fix: generate + curl all assets.
const PORT = process.argv[2] ?? "9226";
const V = "D:\\\\WORKSPACE\\\\ToolBox\\\\src-tauri\\\\target\\\\e2e-vault";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(e.message)); });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stop old server, regenerate, restart preview
await evalJs(`window.__TAURI_INTERNALS__.invoke("blog_preview_stop").catch(()=>{})`);
await sleep(300);
await evalJs(`window.__TAURI_INTERNALS__.invoke("blog_generate", { vault: "${V}", siteTitle: "我的博客" }).then(r => "GEN:" + r.posts).catch(e => "ERR:" + e)`);
const url = await evalJs(`window.__TAURI_INTERNALS__.invoke("blog_preview_start", { vault: "${V}" }).catch(e => "ERR:" + e)`);
console.log("[url]", url);

// Fetch via node (no CORS) to verify all assets
const base = url;
const idx = await fetch(base + "index.html").then(async (r) => ({ s: r.status, t: (await r.text()).slice(0, 80) }));
console.log("[index]", idx.s, idx.t.replace(/\n/g, " "));
const css = await fetch(base + "style.css").then((r) => r.status).catch((e) => "ERR:" + e);
console.log("[style.css]", css);
const post = await fetch(base + "posts/第一篇博客.html").then(async (r) => ({ s: r.status, hasBold: (await r.text()).includes("<strong>第一篇</strong>") })).catch((e) => "ERR:" + e);
console.log("[post page]", JSON.stringify(post));
ws.close();
process.exit(0);
