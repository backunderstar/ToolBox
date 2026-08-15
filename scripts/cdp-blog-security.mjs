// 博客预览服务器安全验证：%2e%2e 路径遍历应被拒绝（404）。
// 用法: node scripts/cdp-blog-security.mjs [port] [vault]
const PORT = process.argv[2] ?? "9226";
const VAULT = process.argv[3] ?? "D:\\WORKSPACE\\ToolBox\\src-tauri\\target\\e2e-vault";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri\.localhost/.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EVAL_ERR:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1500));

// 1. 生成站点 + 启动预览
const gen = await ev(`window.__TAURI_INTERNALS__.invoke('blog_generate', {
  vault: ${JSON.stringify(VAULT)}, siteTitle: '测试站点'
}).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e)`);
console.log("[1] 生成:", gen.slice(0, 150));
const url = await ev(`window.__TAURI_INTERNALS__.invoke('blog_preview_start', {
  vault: ${JSON.stringify(VAULT)}
}).catch(e => 'ERR:' + e)`);
console.log("[2] 预览地址:", url);
if (String(url).startsWith("ERR") || !String(url).startsWith("http")) { console.log("FAIL: 预览未启动"); process.exit(1); }

const base = String(url).replace(/\/$/, "");
const probe = async (label, path) => {
  try {
    const r = await fetch(base + path);
    console.log(`[${label}] ${path} → ${r.status}`);
    return r.status;
  } catch (e) {
    console.log(`[${label}] ${path} → NET_ERR:${e.cause?.code ?? e.message}`);
    return -1;
  }
};

// 3. 遍历请求：%2e%2e 与 .. 都应 404
const p1 = await probe("A", "/%2e%2e/%2e%2e/data/todos/todos.json");
const p2 = await probe("B", "/../data/todos/todos.json");
const p3 = await probe("C", "/%2e%2e/%2e%2e/notes/示例笔记.md");
// 4. 正常路径应 200
const ok1 = await probe("D", "/");
if (p1 !== 404 || p2 !== 404 || p3 !== 404) { console.log("FAIL: 遍历请求应 404"); }
if (ok1 !== 200) { console.log("FAIL: 正常首页应 200"); }

// 5. 停止预览
await ev(`window.__TAURI_INTERNALS__.invoke('blog_preview_stop').catch(e => 'ERR:' + e)`);
console.log("[5] 已停止预览");
ws.close();
if (p1 === 404 && p2 === 404 && p3 === 404 && ok1 === 200) { console.log("=== DONE ==="); process.exit(0); }
process.exit(1);
