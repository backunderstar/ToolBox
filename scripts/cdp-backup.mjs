// E2E 验证自动备份：设置页备份卡片 + 立即备份 + 列表
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
await new Promise((r) => setTimeout(r, 1500));

// 进入设置页
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '设置'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1500));

const cards = await ev(`JSON.stringify([...document.querySelectorAll('.settings-card .settings-title')].map(n => n.textContent))`);
console.log("设置卡片:", cards);

// 点立即备份
const clicked = await ev(`(() => {
  const card = [...document.querySelectorAll('.settings-card')].find(c => (c.querySelector('.settings-title')||{}).textContent === '备份');
  if (!card) return 'no card';
  const btn = [...card.querySelectorAll('button')].find(b => b.textContent.includes('立即备份'));
  if (!btn) return 'no btn';
  btn.click(); return 'clicked';
})()`);
console.log("点击立即备份:", clicked);
await new Promise((r) => setTimeout(r, 2500));

const after = await ev(`JSON.stringify({
  hint: (() => { const card = [...document.querySelectorAll('.settings-card')].find(c => (c.querySelector('.settings-title')||{}).textContent === '备份'); return (card.querySelector('.settings-hint')||{}).textContent || null; })(),
  rows: [...document.querySelectorAll('.backup-row')].map(r => ({ time: (r.querySelector('.backup-time')||{}).textContent, size: (r.querySelector('.backup-size')||{}).textContent })),
  lastText: (() => { const card = [...document.querySelectorAll('.settings-card')].find(c => (c.querySelector('.settings-title')||{}).textContent === '备份'); const rows = [...card.querySelectorAll('.settings-row')]; const last = rows.find(r => (r.querySelector('.settings-label')||{}).textContent === '上次备份'); return (last.querySelector('.settings-value')||{}).textContent || null; })(),
})`);
console.log("备份后:", after);
ws.close();
process.exit(0);
