// 全文搜索性能验证：首次（含建索引）+ 热查询计时。
// 用法: node scripts/cdp-search-bench.mjs [port] [vaultPath]
const PORT = process.argv[2] ?? "9226";
const VAULT = process.argv[3] ?? "D:\\WORKSPACE\\ToolBox\\src-tauri\\target\\bench-vault";
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

const bench = async (label, query) => {
  const t0 = performance.now();
  const r = await ev(`window.__TAURI_INTERNALS__.invoke('fs_search', {
    vault: ${JSON.stringify(VAULT)},
    query: ${JSON.stringify(query)}
  })`);
  const ms = Math.round(performance.now() - t0);
  let summary = "ERR:" + String(r);
  if (Array.isArray(r)) {
    summary = `hits=${r.length} first=${r[0]?.path ?? "-"} snippet="${(r[0]?.snippet ?? "").slice(0, 40)}"`;
  }
  console.log(`[${label}] ${ms}ms  ${summary}`);
  return ms;
};

// 1. 首次搜索：触发全量索引构建（3000 文件）
await bench("首次搜索(建索引)", "工作日报");
// 2. 热查询：增量同步（stat 全量）+ FTS 查询
await bench("热查询", "工作日报");
// 3. 短词（<3 字）回退 LIKE
await bench("短词", "工作");
// 4. 文件名匹配
await bench("文件名", "笔记1");
// 5. 不同词
await bench("热查询2", "项目");
ws.close();
process.exit(0);
