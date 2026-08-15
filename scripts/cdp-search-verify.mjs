// FTS 正确性验证：真实命中 + 增量更新生效。
// 用法: node scripts/cdp-search-verify.mjs [port] [vaultPath]
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

const search = async (query) => {
  const r = await ev(`window.__TAURI_INTERNALS__.invoke('fs_search', {
    vault: ${JSON.stringify(VAULT)},
    query: ${JSON.stringify(query)}
  })`);
  return Array.isArray(r) ? r : [];
};

// 1. FTS 真实命中："相关的任务"（模板里所有文件都有的 5 字串）
let hits = await search("相关的任务");
console.log(`[1] FTS "相关的任务": ${hits.length} 命中, 首条=${hits[0]?.path}`);
if (hits.length < 100) { console.log("FAIL: 应全量命中"); process.exit(1); }

// 2. 精确子串："工作相关"（模板里存在）应命中含"工作"的 ~150 个
hits = await search("工作相关");
console.log(`[2] FTS "工作相关": ${hits.length} 命中, 首条=${hits[0]?.path}, snippet="${(hits[0]?.snippet ?? "").slice(0, 30)}"`);
if (hits.length === 0) { console.log("FAIL: 应命中"); process.exit(1); }

// 3. 增量：向一篇笔记写入独特词 → 热查询应立即命中
// 注意：笔记命令的 rel 需带 notes/ 前缀（与 fs_search 返回的 path 一致）
const marker = "独角兽标记词甲乙丙";
const targetFile = "notes/d0/笔记1001.md";
await ev(`window.__TAURI_INTERNALS__.invoke('fs_write', {
  vault: ${JSON.stringify(VAULT)},
  rel: ${JSON.stringify(targetFile)},
  content: ${JSON.stringify("# 重写内容\\n" + marker + "\\n")}
}).catch(e => 'ERR:' + e)`);
hits = await search(marker);
console.log(`[3] 增量 "${marker}": ${hits.length} 命中, 首条=${hits[0]?.path}`);
if (!hits.some((h) => h.path === targetFile)) { console.log("FAIL: 修改的文件应命中"); process.exit(1); }

// 4. 删除文件 → 索引清理
await ev(`window.__TAURI_INTERNALS__.invoke('fs_delete', {
  vault: ${JSON.stringify(VAULT)},
  rel: ${JSON.stringify(targetFile)}
})`);
hits = await search(marker);
console.log(`[4] 删除后 "${marker}": ${hits.length} 命中`);
if (hits.length !== 0) { console.log("FAIL: 删除后不应命中"); process.exit(1); }

console.log("=== DONE ===");
ws.close();
process.exit(0);
