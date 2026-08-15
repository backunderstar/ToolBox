// CDP smoke test for M4 checklist & records views (mock mode).
// Usage: node scripts/cdp-m4.mjs [port] [waitSec]
const PORT = process.argv[2] ?? "9225";
const URL = "http://localhost:1420/?mock=1";
const WAIT_SEC = Number(process.argv[3] ?? 5);

const target = await fetch(
  `http://localhost:${PORT}/json/new?` + encodeURIComponent(URL),
  { method: "PUT" }
).then((r) => r.json());

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = (e) => rej(new Error("WS error: " + e.message));
});
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      cb(m);
    }
  } else if (m.method) {
    events.push(m);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send("Runtime.enable");
await send("Log.enable");
console.log(`[m4-test] waiting ${WAIT_SEC}s...`);
await new Promise((r) => setTimeout(r, WAIT_SEC * 1000));

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickNav = async (label) =>
  evalJs(`(() => {
    const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('${label}'));
    if (!b) return 'NO_NAV'; b.click(); return 'CLICKED';
  })()`);

// 1. Open 清单
console.log("[1]", await clickNav("清单"));
await sleep(500);
console.log("[1] checklist rows:", await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('.checklist-row-title')].map(x => x.textContent)
))()`));

// 2. Open 周计划
console.log("[2]", await evalJs(`(() => {
  const r = [...document.querySelectorAll('.checklist-row')].find(x => x.textContent.includes('周计划'));
  if (!r) return 'NO_ROW'; r.click(); return 'OPENED';
})()`));
await sleep(400);
console.log("[2] editor:", await evalJs(`(() => JSON.stringify({
  title: document.querySelector('.checklist-title-input')?.value,
  items: [...document.querySelectorAll('.checklist-item-text')].map(i => i.value),
  progress: document.querySelector('.checklist-progress-text')?.textContent,
  noteLinks: [...document.querySelectorAll('.checklist-item-note .note-link')].map(n => n.textContent.trim())
}))()`));

// 3. Toggle first item -> progress updates
console.log("[3]", await evalJs(`(async () => {
  const cb = document.querySelector('.checklist-check input');
  if (!cb) return 'NO_CHECKBOX';
  cb.click();
  await new Promise(r => setTimeout(r, 300));
  return document.querySelector('.checklist-progress-text')?.textContent;
})()`));

// 4. Add new item
console.log("[4]", await evalJs(`(async () => {
  const input = document.querySelector('.checklist-add .checklist-new-input');
  if (!input) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '新加条目测试');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = document.querySelector('.checklist-add .btn');
  btn.click();
  await new Promise(r => setTimeout(r, 300));
  const texts = [...document.querySelectorAll('.checklist-item-text')].map(i => i.value);
  return texts.includes('新加条目测试') ? 'ADDED' : 'NOT_ADDED:' + JSON.stringify(texts);
})()`));

// 5. Click note link in checklist -> jump to notes view
console.log("[5]", await evalJs(`(async () => {
  const link = document.querySelector('.checklist-item-note .note-link');
  if (!link) return 'NO_LINK';
  link.click();
  await new Promise(r => setTimeout(r, 500));
  return 'view=' + (document.querySelector('.nav-item.active')?.textContent.trim() ?? '?') +
    '|editor=' + (document.querySelector('.editor-title')?.textContent ?? '?');
})()`));

// 6. Backlinks panel in notes view (示例笔记.md is referenced)
console.log("[6] backlinks:", await evalJs(`(async () => {
  const bar = document.querySelector('.backlinks-toggle');
  if (!bar) return 'NO_BAR';
  bar.click();
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify([...document.querySelectorAll('.backlink-item')].map(b => b.textContent.trim()));
})()`));

// 7. Open 记录
console.log("[7]", await clickNav("记录"));
await sleep(500);
console.log("[7] records:", await evalJs(`(() => JSON.stringify({
  rows: [...document.querySelectorAll('.record-row-title')].map(x => x.textContent),
  count: document.querySelector('.records-count')?.textContent,
  stats: document.querySelector('.records-stats')?.textContent.trim().replace(/\\s+/g, ' '),
  tags: [...document.querySelectorAll('.record-tag-chip')].map(t => t.textContent.trim())
}))()`));

// 8. Open first record, verify editor + links
console.log("[8]", await evalJs(`(() => {
  const r = document.querySelector('.record-row');
  if (!r) return 'NO_ROW'; r.click(); return 'OPENED';
})()`));
await sleep(400);
console.log("[8] editor:", await evalJs(`(() => JSON.stringify({
  title: document.querySelector('.record-title-input')?.value,
  date: document.querySelector('.record-date-input')?.value,
  links: [...document.querySelectorAll('.record-links .note-link')].map(n => n.textContent.trim()),
  contentLen: document.querySelector('.record-content-input')?.value.length
}))()`));

// 9. Tag filter
console.log("[9]", await evalJs(`(async () => {
  const chip = [...document.querySelectorAll('.record-tag-chip')].find(t => t.textContent.includes('开发'));
  if (!chip) return 'NO_CHIP';
  chip.click();
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify([...document.querySelectorAll('.record-row-title')].map(x => x.textContent));
})()`));

console.log("--- CONSOLE / ERRORS ---");
let errCount = 0;
for (const ev of events) {
  if (ev.method === "Runtime.consoleAPICalled" && (ev.params.type === "error" || ev.params.type === "warning")) {
    errCount++;
    console.log(`[${ev.params.type}]`, ev.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (ev.method === "Runtime.exceptionThrown") {
    errCount++;
    const d = ev.params.exceptionDetails;
    console.log("[exception]", d.text, "@", d.url ?? "", "line", d.lineNumber);
    if (d.exception?.description) console.log("  ", d.exception.description.split("\n").slice(0, 6).join("\n   "));
  }
}
console.log(`errors/warnings captured: ${errCount}`);
ws.close();
console.log("=== DONE ===");
process.exit(0);
