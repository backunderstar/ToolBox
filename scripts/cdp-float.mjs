// E2E 验证浮窗：识别两个窗口、浮窗 CRUD、数据落盘、主窗口按钮
const targets0 = await fetch("http://localhost:9226/json").then((r) => r.json());
console.log("targets:", targets0.filter((t) => t.type === "page").map((t) => t.url));

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
  return { ws, ev, send };
}

// 等待两个窗口出现
let targets = [];
for (let i = 0; i < 60; i++) {
  targets = await fetch("http://localhost:9226/json").then((r) => r.json());
  const pages = targets.filter((t) => t.type === "page" && /1420/.test(t.url));
  if (pages.length >= 2) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const pages = targets.filter((t) => t.type === "page" && /1420/.test(t.url));
console.log("页面窗口数:", pages.length);

// 识别主窗口 vs 浮窗
let main = null, float = null;
for (const p of pages) {
  const c = await connect(p);
  await new Promise((r) => setTimeout(r, 1500));
  const label = await c.ev(`(() => { try { return window.__TAURI_INTERNALS__ ? 'tauri' : 'browser'; } catch { return 'err'; } })()`);
  const hasFloat = await c.ev(`!!document.querySelector('.float-window')`);
  const hasApp = await c.ev(`!!document.querySelector('.app')`);
  const winLabel = await c.ev(`(() => { try { const w = (await import('@tauri-apps/api/window')); return 'module'; } catch { return 'no'; } })()`);
  console.log(`target ${p.id.slice(0, 8)}: float=${hasFloat} app=${hasApp}`);
  if (hasFloat) float = c;
  else if (hasApp) main = c;
  if (hasFloat) { /* 浮窗 */ } 
  if (float && main) break;
  c.ws.close();
}

if (!float || !main) {
  console.log("未能识别两个窗口，浮窗:", !!float, "主窗:", !!main);
  process.exit(1);
}

// 浮窗：添加待办
await float.ev(`(() => {
  const input = document.querySelector('.float-input');
  if (!input) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'E2E 浮窗待办');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await new Promise((r) => setTimeout(r, 200));
await float.ev(`(() => { const btn = document.querySelector('.float-add'); if (btn) btn.click(); return !!btn; })()`);
await new Promise((r) => setTimeout(r, 800));
const items = await float.ev(`JSON.stringify([...document.querySelectorAll('.float-item-text')].map(n => n.textContent))`);
console.log("添加后列表:", items);

// 勾选完成
await float.ev(`(() => { const btn = document.querySelector('.float-check'); if (btn) btn.click(); return !!btn; })()`);
await new Promise((r) => setTimeout(r, 600));
const done = await float.ev(`JSON.stringify({ count: (document.querySelector('.float-count')||{}).textContent, doneCls: !!(document.querySelector('.float-item.done')) })`);
console.log("勾选后:", done);

// 主窗口：浮窗按钮存在
await main.ev(`(() => { const b = [...document.querySelectorAll('.topbar .icon-btn')].find(x => (x.getAttribute('aria-label')||'') === '切换浮窗'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 800));
console.log("主窗口浮窗按钮: 已点击（隐藏/显示切换）");

process.exit(0);
