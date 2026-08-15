// CDP measure v2: 模拟 1600x900 桌面窗口，量编辑器高度链 + 各视图右侧空白
const PORT = process.argv[2] ?? "9225";
const W = Number(process.argv[3] ?? 1600);
const H = Number(process.argv[4] ?? 900);

const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
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
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));

// 进入笔记视图
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '笔记'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1500));

const h = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? Math.round(el.getBoundingClientRect().height) : null; })()`;
const w = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; })()`;

const chain = await ev(`JSON.stringify({
  win: [innerWidth, innerHeight],
  topbar: ${h(".topbar")}, statusbar: ${h(".statusbar")}, main: ${h(".main")},
  editorArea: ${h(".editor-area")}, editorHeader: ${h(".editor-header")},
  editorBody: ${h(".editor-body")}, vditorToolbar: ${h(".editor-host .vditor-toolbar")},
  vditorContent: ${h(".editor-host .vditor-content")}, vditorIr: ${h(".editor-host .vditor-ir")},
})`);
console.log("== 编辑器高度链 (", W, "x", H, ") ==");
console.log(JSON.parse(chain));

const navMap = { overview: "概览", notes: "笔记", plugins: "插件", tools: "数据工具", checklist: "清单", records: "记录", ai: "AI 整理", blog: "博客发布", settings: "设置" };
console.log("== 各视图宽度 ==");
for (const [v, label] of Object.entries(navMap)) {
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 800));
  const out = await ev(`(() => {
    const main = document.querySelector('.main'); const mr = main.getBoundingClientRect();
    const inner = document.querySelector('.main > div');
    const innerRect = inner ? inner.getBoundingClientRect() : null;
    const blank = innerRect ? Math.round(mr.right - innerRect.right) : null;
    // 具体内容列
    const cols = ['.plugin-list', '.tool-grid', '.tools-plugins .plugin-list', '.tool-workspace', '.settings-sections', '.ai-body', '.blog-detail', '.checklist-editor', '.record-editor'];
    const found = {};
    for (const sel of cols) {
      const el = document.querySelector(sel);
      if (el) { const r = el.getBoundingClientRect(); found[sel] = { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; }
    }
    return JSON.stringify({ mainW: Math.round(mr.width), innerW: innerRect ? Math.round(innerRect.width) : null, blank, found });
  })()`);
  const d = JSON.parse(out);
  const parts = [`[${v.padEnd(9)}] main=${d.mainW} inner=${d.innerW} 空白=${d.blank}`];
  for (const [sel, r] of Object.entries(d.found)) parts.push(`${sel}: ${r.w}px (右边界距 main 右 ${d.mainW - r.r}px)`);
  console.log(parts.join(" | "));
}

// 截图
await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.title === '笔记'); if (b) b.click(); return !!b; })()`);
await new Promise((r) => setTimeout(r, 1000));
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot.result?.data) {
  const fs = await import("node:fs");
  fs.writeFileSync("scripts/measure-notes.png", Buffer.from(shot.result.data, "base64"));
  console.log("截图已保存 scripts/measure-notes.png");
}
ws.close();
process.exit(0);
