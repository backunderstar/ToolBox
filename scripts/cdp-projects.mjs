// E2E 验证 M8 项目文件管理：列表/新建/归档/详情/文件打开
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

// 覆盖 confirm（headless 弹窗会阻塞）
await ev(`window.confirm = () => true;`);

// 进入项目视图
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '项目'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1500));

const initial = await ev(`JSON.stringify({
  view: (document.querySelector('.sidebar .nav-item.active')||{}).title,
  cards: [...document.querySelectorAll('.project-card-name')].map(n => n.textContent),
  sections: [...document.querySelectorAll('.projects-section .section-title')].map(n => n.textContent),
})`);
console.log("初始:", initial);

// 新建项目
await ev(`(() => {
  const input = document.querySelector('.projects-new-input');
  if (!input) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'E2E项目');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await new Promise((r) => setTimeout(r, 300));
await ev(`(() => { const btn = [...document.querySelectorAll('.projects-new button')].find(b => b.textContent.includes('新建项目')); if (btn) btn.click(); return !!btn; })()`);
await new Promise((r) => setTimeout(r, 1500));

const afterCreate = await ev(`JSON.stringify([...document.querySelectorAll('.project-card-name')].map(n => n.textContent))`);
console.log("新建后:", afterCreate);

// 归档 E2E项目
await ev(`(() => {
  const cards = [...document.querySelectorAll('.project-card')];
  const c = cards.find(x => (x.querySelector('.project-card-name')||{}).textContent === 'E2E项目');
  if (!c) return 'no card';
  const btn = [...c.querySelectorAll('button')].find(b => b.textContent === '归档');
  if (btn) btn.click(); return 'archived';
})()`);
await new Promise((r) => setTimeout(r, 1500));
const afterArchive = await ev(`JSON.stringify({
  active: [...document.querySelectorAll('.projects-section')].map(s => ({
    title: (s.querySelector('.section-title')||{}).textContent,
    names: [...s.querySelectorAll('.project-card-name')].map(n => n.textContent),
  })),
})`);
console.log("归档后:", afterArchive);

// 还原 E2E项目
await ev(`(() => {
  const cards = [...document.querySelectorAll('.project-card')];
  const c = cards.find(x => (x.querySelector('.project-card-name')||{}).textContent === 'E2E项目');
  if (!c) return 'no card';
  const btn = [...c.querySelectorAll('button')].find(b => b.textContent === '还原');
  if (btn) btn.click(); return 'restored';
})()`);
await new Promise((r) => setTimeout(r, 1500));

// 进入"示例项目"详情
await ev(`(() => {
  const cards = [...document.querySelectorAll('.project-card')];
  const c = cards.find(x => (x.querySelector('.project-card-name')||{}).textContent === '示例项目');
  if (!c) return 'no card';
  (c.querySelector('.project-card-main')).click(); return 'opened';
})()`);
await new Promise((r) => setTimeout(r, 1500));
const detail = await ev(`JSON.stringify({
  title: (document.querySelector('.project-detail-title')||{}).textContent,
  files: [...document.querySelectorAll('.project-file-row')].map(r => ({
    name: (r.querySelector('.project-file-name')||{}).textContent,
    size: (r.querySelector('.project-file-size')||{}).textContent,
    isDir: !!r.querySelector('.project-file-open'),
  })),
})`);
console.log("详情:", detail);

// 点击文件 → 打开（验证命令调用不报错）
const openResult = await ev(`(() => {
  const row = [...document.querySelectorAll('.project-file-row')].find(r => (r.querySelector('.project-file-name')||{}).textContent === '需求文档.txt');
  if (!row) return 'no file row';
  (row.querySelector('.project-file-main')).click();
  return 'clicked';
})()`);
console.log("点击文件:", openResult);
await new Promise((r) => setTimeout(r, 1000));
const notice = await ev(`(document.querySelector('.projects-notice')||{}).textContent || null`);
console.log("提示:", notice);

// 进入子目录
await ev(`(() => {
  const row = [...document.querySelectorAll('.project-file-row')].find(r => (r.querySelector('.project-file-name')||{}).textContent === '子目录');
  if (!row) return 'no dir';
  (row.querySelector('.project-file-main')).click(); return 'entered';
})()`);
await new Promise((r) => setTimeout(r, 1200));
const sub = await ev(`JSON.stringify({
  crumbs: [...document.querySelectorAll('.crumb')].map(c => c.textContent),
  files: [...document.querySelectorAll('.project-file-name')].map(n => n.textContent),
})`);
console.log("子目录:", sub);
ws.close();
process.exit(0);
