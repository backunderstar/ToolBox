// E2E 验证浮窗数据层：todos CRUD 落盘 + float_toggle 显隐
const targets = await fetch("http://localhost:9226/json").then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420/.test(t.url));
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
  if (r.result?.exceptionDetails) return "EXC: " + JSON.stringify(r.result.exceptionDetails).slice(0, 200);
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 1500));

const invoke = (cmd, args = {}) =>
  ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(v => JSON.stringify(v)).catch(e => 'ERR:' + e)`);

// 1. 添加两条待办
const afterAdd = JSON.parse(await invoke("todos_add", { text: "E2E 浮窗待办一" }));
console.log("添加一:", afterAdd.length, afterAdd.map((i) => i.text).join(" / "));
const afterAdd2 = JSON.parse(await invoke("todos_add", { text: "E2E 浮窗待办二" }));
console.log("添加二:", afterAdd2.length);

// 2. 勾选第一条
const first = afterAdd2[0];
const afterToggle = JSON.parse(await invoke("todos_toggle", { id: first.id }));
console.log("勾选:", afterToggle.find((i) => i.id === first.id)?.done);

// 3. 删除第二条
const afterDel = JSON.parse(await invoke("todos_delete", { id: afterAdd2[1].id }));
console.log("删除后剩余:", afterDel.length, afterDel.map((i) => i.text).join(" / "));

// 4. 空文本拒绝
const errEmpty = await invoke("todos_add", { text: "   " });
console.log("空文本:", errEmpty.startsWith("ERR") ? "拒绝 ✓" : "未拒绝 ✗");

// 5. 清空已完成
const afterClear = JSON.parse(await invoke("todos_clear_done"));
console.log("清除已完成后:", afterClear.length);

// 6. float_toggle 显隐
console.log("toggle1:", await invoke("float_toggle"));
console.log("toggle2:", await invoke("float_toggle"));
ws.close();
process.exit(0);
