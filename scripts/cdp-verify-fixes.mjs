// 验证 #2/#3/#6：插件状态、工具列表、视图宽度
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
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 800));

const go = async (label) => {
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 1200));
};

// #2 插件页
await go("插件");
const plugins = await ev(`JSON.stringify([...document.querySelectorAll('.plugin-card')].map(c => ({
  name: (c.querySelector('.plugin-title h2')||{}).textContent,
  status: (c.querySelector('.badge-status')||{}).textContent,
  statusCls: (c.querySelector('.badge-status')||{}).className,
  enabledBtn: (c.querySelector('.plugin-actions .btn')) ? (c.querySelector('.plugin-actions .btn')).textContent : null,
  error: (c.querySelector('.plugin-error')||{}).textContent || null,
})))`);
console.log("#2 插件页:", plugins);

// #3 工具页
await go("数据工具");
const tools = await ev(`JSON.stringify([...document.querySelectorAll('.tool-card-name')].map(n => n.textContent))`);
console.log("#3 工具列表:", tools);

// #6 各视图宽度
const widthInfo = await ev(`(() => {
  const main = document.querySelector('.main'); const mr = main.getBoundingClientRect();
  const sels = ['.tool-grid', '.tool-workspace', '.plugin-list'];
  const found = {};
  for (const s of sels) { const el = document.querySelector(s); if (el) { const r = el.getBoundingClientRect(); found[s] = Math.round(mr.right - r.right); } }
  return JSON.stringify({ mainW: Math.round(mr.width), blankRight: found });
})()`);
console.log("#6 工具视图空白:", widthInfo);

await go("设置");
await new Promise((r) => setTimeout(r, 400));
const settings = await ev(`(() => {
  const main = document.querySelector('.main'); const mr = main.getBoundingClientRect();
  const el = document.querySelector('.settings-sections'); const r = el.getBoundingClientRect();
  return JSON.stringify({ mainW: Math.round(mr.width), sectionsW: Math.round(r.width), leftGap: Math.round(r.left - mr.left), rightGap: Math.round(mr.right - r.right) });
})()`);
console.log("#6 设置视图:", settings);
ws.close();
process.exit(0);
