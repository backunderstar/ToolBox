// 验证 #2：启用文本统计插件后状态显示"就绪"
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

await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '插件'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1500));

const dump = async (label) => {
  const s = await ev(`JSON.stringify([...document.querySelectorAll('.plugin-card')].map(c => ({
    name: (c.querySelector('.plugin-title h2')||{}).textContent,
    status: (c.querySelector('.badge-status')||{}).textContent,
    btn: (c.querySelector('.plugin-actions .btn')) ? (c.querySelector('.plugin-actions .btn')).textContent : null,
  })))`);
  console.log(label, s);
};

await dump("启用前:");
// 点文本统计的启用按钮（第二个插件卡片）
const clicked = await ev(`(() => {
  const cards = [...document.querySelectorAll('.plugin-card')];
  const c = cards.find(x => (x.querySelector('.plugin-title h2')||{}).textContent === '文本统计');
  if (!c) return 'no card';
  const btn = c.querySelector('.plugin-actions .btn');
  if (!btn) return 'no btn';
  if (btn.textContent !== '启用') return 'btn text: ' + btn.textContent;
  btn.click(); return 'clicked';
})()`);
console.log("操作:", clicked);
await new Promise((r) => setTimeout(r, 2500));
await dump("启用后:");
ws.close();
process.exit(0);
