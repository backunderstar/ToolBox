// 布局诊断：dump 版本历史视图关键元素的几何 + 与记录/插件视图头部对比
const PORT = process.argv[2] ?? "9226";
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
  if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");
await sleep(1000);

const nav = async (label) => {
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
};

// 诊断一个视图的布局骨架
const dumpView = async (label) => {
  await nav(label);
  const info = await ev(`(() => {
    const v = document.querySelector('.view, .records-view, .checklist-view, .projects-view, .blog-view, .settings-view, .plugins-view');
    const header = v?.querySelector('.view-header');
    const main = v ? [...v.children].find(c => c !== header) : null;
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const style = (el, props) => { if (!el) return null; const cs = getComputedStyle(el); const o = {}; for (const p of props) o[p] = cs[p]; return o; };
    return {
      view: rect(v), viewClass: v?.className,
      viewPad: style(v, ['padding', 'paddingTop', 'paddingLeft', 'maxWidth', 'width']),
      header: rect(header), headerClass: header?.className,
      headerH: style(header, ['marginBottom', 'alignItems']),
      h1: style(v?.querySelector('.view-header h1'), ['fontSize', 'fontWeight', 'margin']),
      sub: style(v?.querySelector('.view-sub'), ['fontSize', 'color']),
      main: rect(main), mainClass: main?.className,
      firstChildClass: main ? [...main.children].slice(0, 3).map(c => c.className) : null,
    };
  })()`);
  console.log("=== " + label + " ===");
  console.log(JSON.stringify(info, null, 1));
};

await dumpView("版本历史");
await dumpView("记录");
await dumpView("插件");

ws.close();
process.exit(0);
