// 回归：webview 插件 Blob URL 执行路径（替代 new Function）。
// 用法: node scripts/cdp-plugin-blob.mjs [port]
// 前提: tauri dev 带 9226 调试端口, vault 指向 e2e-vault（含 text-stats 插件）
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri\.localhost/.test(t.url)) ?? targets.find((t) => t.type === "page");
if (!page) { console.error("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EVAL_ERR: " + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send("Runtime.enable");
await send("Log.enable");
await new Promise((r) => setTimeout(r, 1000));

// 1. 进入插件视图
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '插件'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1500));

const dump = async (label) => {
  const s = await ev(`JSON.stringify([...document.querySelectorAll('.plugin-card')].map(c => ({
    name: (c.querySelector('.plugin-title h2')||{}).textContent,
    status: (c.querySelector('.badge-status')||{}).textContent,
    btn: (c.querySelector('.plugin-actions .btn')||{}).textContent ?? null,
  })))`);
  console.log(label, s);
};
await dump("[1] 初始:");

// 2. 确保文本统计已启用（未启用则点启用）
const enabled = await ev(`(async () => {
  const cards = [...document.querySelectorAll('.plugin-card')];
  const c = cards.find(x => (x.querySelector('.plugin-title h2')||{}).textContent === '文本统计');
  if (!c) return 'no card';
  const btn = c.querySelector('.plugin-actions .btn');
  if (!btn) return 'no btn';
  if (btn.textContent === '启用') { btn.click(); await new Promise(r => setTimeout(r, 2500)); return 'enabled-now'; }
  return 'already:' + btn.textContent;
})()`);
console.log("[2] 启用:", enabled);
await new Promise((r) => setTimeout(r, 500));
await dump("[3] 启用后:");

// 3. 验证 Blob 执行路径痕迹：按插件独立的全局句柄已清理（无并发串台残留）
const cleaned = await ev(`(() => {
  const keys = Object.keys(window).filter(k => k.startsWith('__TB_PLUGIN_API_'));
  return keys.length === 0 ? 'OK(clean)' : 'LEAK:' + keys.join(',');
})()`);
console.log("[4] 插件 api 句柄已清理:", cleaned);

// 4. 试用 analyze 命令
await ev(`(() => { const b = document.querySelector('.command-try'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 500));
const runRes = await ev(`(async () => {
  const ta = document.querySelector('.try-args');
  if (!ta) return 'NO_ARGS';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, JSON.stringify({ text: '你好世界\\n第二行\\n\\n新段' }));
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const btn = [...document.querySelectorAll('.try-head .btn')].find(b => b.textContent.includes('运行'));
  if (!btn) return 'NO_RUN_BTN';
  btn.click();
  await new Promise(r => setTimeout(r, 800));
  const res = document.querySelector('.try-result');
  return res ? res.textContent : 'NO_RESULT_YET';
})()`);
console.log("[5] analyze 运行结果:", runRes);

// 5. 收集错误
let errCount = 0;
for (const evt of events) {
  if (evt.method === "Runtime.exceptionThrown") {
    errCount++;
    console.log("[exception]", evt.params.exceptionDetails.text, "@", evt.params.exceptionDetails.url ?? "");
  }
  if (evt.method === "Runtime.consoleAPICalled" && (evt.params.type === "error" || evt.params.type === "warning")) {
    errCount++;
    console.log(`[${evt.params.type}]`, evt.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
}
console.log(`[6] 错误/警告数: ${errCount}`);
ws.close();
process.exit(0);
