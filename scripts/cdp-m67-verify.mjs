// Verify blog site files on disk + preview server HTTP + ai.json persistence.
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

// Preview URL from the running server (idempotent call returns existing)
const url = await evalJs(
  `window.__TAURI_INTERNALS__.invoke("blog_preview_start", { vault: "${V}" }).catch(e => "ERR:" + e)`
);
console.log("[preview url]", url);
const idx = await evalJs(
  `fetch(${JSON.stringify(url + "index.html")}).then(r => r.status + "|" + r.text().then(t => t.includes("第一篇博客") ? "HAS_POST" : "NO_POST")).catch(e => "FETCH_ERR:" + e)`
);
console.log("[index.html]", idx);
const postHtml = await evalJs(
  `fetch(${JSON.stringify(url + "posts/第一篇-博客.html")}).then(r => r.status).catch(e => "FETCH_ERR:" + e)`
);
console.log("[post page]", postHtml);
ws.close();
process.exit(0);
