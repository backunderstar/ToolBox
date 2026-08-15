// 打包版 CSP 验证：检查 HTTP 响应头注入（Tauri 2 方式）、无 violation、核心功能冒烟。
// 用法: node scripts/cdp-csp-check.mjs [port] [mode]
//   mode = "prod"（默认）: 断言 http://tauri.localhost 响应头含 CSP 且指令正确
//   mode = "dev"         : 断言无 CSP（devCsp: null）
const PORT = process.argv[2] ?? "9226";
const MODE = process.argv[3] ?? "prod";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const pages = targets.filter((t) => t.type === "page");
const page = pages.find((t) => /1420/.test(t.url)) ?? pages[0];
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const events = [];
let headerCsp = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
  else if (m.method === "Network.responseReceived") {
    const h = m.params.response.headers ?? {};
    const csp = h["content-security-policy"] ?? h["Content-Security-Policy"];
    if (csp && /tauri\.localhost/.test(m.params.response.url)) headerCsp = csp;
    events.push(m);
  }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EVAL_ERR:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Network.enable");

// 重载页面抓响应头 + 收集加载期错误
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 4000));

const meta = await ev(`(() => {
  const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  return m ? m.getAttribute('content') : null;
})()`);
console.log("[1] CSP meta:", meta === null ? "(none，Tauri 走响应头)" : meta.slice(0, 120));
if (MODE === "prod") {
  if (!headerCsp) { console.log("FAIL: 未捕获到 http://tauri.localhost 的 CSP 响应头"); process.exit(1); }
  console.log("[1b] CSP 响应头:", headerCsp.slice(0, 260) + (headerCsp.length > 260 ? "..." : ""));
  const checks = [
    ["script-src 含 blob:", /script-src[^;]*blob:/.test(headerCsp)],
    ["无 unsafe-eval:", !/unsafe-eval/.test(headerCsp)],
    ["style-src 含 unsafe-inline:", /style-src[^;]*'unsafe-inline'/.test(headerCsp)],
    ["connect-src 含 ipc:", /connect-src[^;]*ipc:/.test(headerCsp)],
    ["object-src none:", /object-src 'none'/.test(headerCsp)],
    ["base-uri none:", /base-uri 'none'/.test(headerCsp)],
  ];
  let ok = true;
  for (const [label, pass] of checks) { console.log(`   ${pass ? "OK " : "FAIL"} ${label}`); if (!pass) ok = false; }
  if (!ok) process.exit(1);
} else {
  if (headerCsp) console.log("WARN: dev 模式不应有 CSP（devCsp: null）");
}

// 2. 应用初始化冒烟：欢迎页（首次运行，dev/打包 origin 不同 → localStorage 隔离）
const boot = await ev(`(() => ({
  root: !!document.querySelector('#root'),
  sidebar: !!document.querySelector('.sidebar'),
  welcome: !!document.querySelector('.welcome'),
  ipc: (document.querySelector('.env-value.ok') ?? {}).textContent ?? null,
}))()`);
console.log("[2] 冒烟:", JSON.stringify(boot));

// 2b. 若在欢迎页：确认 IPC 正常后点击"进入笔记"
const entered = await ev(`(async () => {
  const btn = document.querySelector('.welcome .btn-primary');
  if (!btn) return 'no-welcome-btn';
  const ipc = document.querySelector('.env-value.ok');
  if (!ipc) return 'ipc-not-ok';
  btn.click();
  await new Promise(r => setTimeout(r, 2500));
  return 'entered';
})()`);
console.log("[2b] 进入笔记:", entered);

// 3. 打开一篇笔记，确认 Vditor 编辑器渲染（style-src 不拦截）
await ev(`(() => {
  const rows = [...document.querySelectorAll('.tree-row')];
  const note = rows.find(r => r.textContent.trim().endsWith('.md'));
  if (note) note.click();
  return !!note;
})()`);
await new Promise((r) => setTimeout(r, 3000));
const editor = await ev(`(() => ({
  vditor: !!document.querySelector('.vditor'),
  ir: !!document.querySelector('.vditor-ir'),
  toolbar: !!document.querySelector('.vditor-toolbar'),
}))()`);
console.log("[3] Vditor:", JSON.stringify(editor));

// 4. 收集 CSP violation / 异常
let violations = 0;
let errors = 0;
for (const evt of events) {
  if (evt.method === "Log.entryAdded") {
    const t = evt.params.entry.text ?? "";
    if (/Content Security Policy|Refused to/.test(t)) {
      violations++;
      console.log("[CSP violation]", t.slice(0, 200));
    } else if (evt.params.entry.level === "error") {
      errors++;
      console.log("[log.error]", t.slice(0, 200));
    }
  }
  if (evt.method === "Runtime.exceptionThrown") {
    errors++;
    console.log("[exception]", evt.params.exceptionDetails.text, "@", evt.params.exceptionDetails.url ?? "");
  }
}
console.log(`[4] CSP violations: ${violations}, errors: ${errors}`);
ws.close();
if (violations > 0) { console.log("FAIL: 存在 CSP violation"); process.exit(1); }
console.log("=== DONE ===");
process.exit(0);
