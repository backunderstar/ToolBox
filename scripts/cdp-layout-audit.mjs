// UI 布局体检：各视图的横向溢出/挤压/关键容器尺寸。
// 用法: node scripts/cdp-layout-audit.mjs [port]
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
  if (r.result?.exceptionDetails) return "EVAL_ERR:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 2000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = async (label) => {
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`);
  await sleep(1400);
};

const audit = async (label) => {
  const r = await ev(`(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const doc = document.scrollingElement;
    const hScroll = doc.scrollWidth > doc.clientWidth + 1;
    // 找出明显超出视口右缘的元素（排除 sidebar 内正常元素）
    const over = [];
    document.querySelectorAll('body *').forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > vw + 2 && rect.left < vw && !el.closest('.sidebar')) {
        over.push(el.className?.toString().slice(0, 40) || el.tagName);
      }
    });
    return JSON.stringify({
      viewport: vw + 'x' + vh,
      hScroll,
      overflowEls: [...new Set(over)].slice(0, 8),
      mainRight: (document.querySelector('.main')?.getBoundingClientRect().right ?? 0).toFixed(0),
    });
  })()`);
  console.log(`[${label}]`, r);
};

await audit("welcome");
await nav("笔记");
await sleep(500);
await audit("notes");
await nav("设置");
await audit("settings");
await nav("插件");
await audit("plugins");
await nav("项目");
await audit("projects");
await nav("数据工具");
await audit("tools");
await nav("清单");
await audit("checklist");
await nav("记录");
await audit("records");
await nav("AI 整理");
await audit("ai");
await nav("博客发布");
await audit("blog");
ws.close();
console.log("=== DONE ===");
process.exit(0);
