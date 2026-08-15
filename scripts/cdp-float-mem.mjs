// 浮窗可见性记忆验证：float_toggle → %APPDATA% float.json 写入
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
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
  if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1000));

// 连续两次 toggle：隐藏 → 显示（各自写状态）
const r1 = await ev(`window.__TAURI_INTERNALS__.invoke('float_toggle').then(v => v).catch(e => 'ERR:' + e)`);
const r2 = await ev(`window.__TAURI_INTERNALS__.invoke('float_toggle').then(v => v).catch(e => 'ERR:' + e)`);
console.log("[toggle] 1:", r1, " 2:", r2);
// 最终状态恢复为显示（默认）——再 toggle 一次变隐藏并检查文件
const r3 = await ev(`window.__TAURI_INTERNALS__.invoke('float_toggle').then(v => v).catch(e => 'ERR:' + e)`);
console.log("[toggle] 3(应隐藏=false):", r3);
ws.close();
process.exit(0);
