// E2E part 2: file tree, open note in real Vditor, backlinks, edit+save persistence.
// Usage: node scripts/cdp-e2e2.mjs [port]
const PORT = process.argv[2] ?? "9226";

const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url));
if (!page) { console.log("NO_PAGE_TARGET"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("WS error: " + e.message)); });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) {
    const cb = pending.get(m.id);
    if (cb) { pending.delete(m.id); cb(m); }
  } else if (m.method) { events.push(m); }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await send("Runtime.enable");
await send("Log.enable");

const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return "EXC: " + (r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Navigate to notes view, wait for file tree populated
await evalJs(`(() => {
  const b = [...document.querySelectorAll('.nav-item')].find(x => x.textContent.includes('笔记'));
  b?.click(); return 'ok';
})()`);
await sleep(800);
let tree = null;
for (let i = 0; i < 12; i++) {
  tree = await evalJs(`(() => JSON.stringify([...document.querySelectorAll('.tree-name')].map(x => x.textContent)))()`);
  if (tree && tree !== "[]") break;
  await sleep(1000);
}
console.log("[1] file tree:", tree);

// 2. Open 示例笔记.md in real Vditor
await evalJs(`(() => {
  const n = [...document.querySelectorAll('.tree-name')].find(x => x.textContent.includes('示例笔记'));
  if (n) n.closest('.tree-row')?.click();
  return 'ok';
})()`);
await sleep(2500);
const note = await evalJs(`(() => ({
  active: document.querySelector('.editor-title')?.textContent ?? null,
  ir: !!document.querySelector('.vditor-ir'),
  vditorClass: document.querySelector('.editor-host')?.className ?? null,
  textLen: document.querySelector('.vditor-ir')?.textContent?.length ?? -1,
  dirty: document.querySelector('.dirty-dot')?.className ?? null
}))()`);
console.log("[2] note:", JSON.stringify(note));

// 3. Backlinks bar (record references 示例笔记.md)
const back = await evalJs(`(async () => {
  const bar = document.querySelector('.backlinks-toggle');
  if (!bar) return 'NO_BAR';
  bar.click();
  await new Promise(r => setTimeout(r, 300));
  return JSON.stringify([...document.querySelectorAll('.backlink-item')].map(b => b.textContent.trim()));
})()`);
console.log("[3] backlinks:", back);

// 4. Real typing into Vditor IR via CDP Input.insertText, then autosave -> disk
const typed = await evalJs(`(async () => {
  const ir = document.querySelector('.vditor-ir');
  if (!ir) return 'NO_IR';
  // focus the editable area
  const editable = ir.querySelector('[contenteditable="true"]') || ir;
  editable.focus();
  // place caret at end
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  return 'FOCUSED';
})()`);
console.log("[4] focus:", typed);
await sleep(300);
await send("Input.insertText", { text: "\nE2E 真实键入验证段落" });
await sleep(2000); // vditor onChange -> autosave 800ms
const after = await evalJs(`(() => ({
  textLen: document.querySelector('.vditor-ir')?.textContent?.length ?? -1,
  hasE2E: document.querySelector('.vditor-ir')?.textContent?.includes('E2E 真实键入验证段落') ?? false
}))()`);
console.log("[4] after typing:", JSON.stringify(after));

console.log("--- CONSOLE ERRORS ---");
let errCount = 0;
for (const ev of events) {
  if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
    errCount++;
    console.log("[console.error]", ev.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (ev.method === "Runtime.exceptionThrown") {
    errCount++;
    console.log("[exception]", ev.params.exceptionDetails.text, ev.params.exceptionDetails.exception?.description?.split("\n").slice(0,4).join("\n   ") ?? "");
  }
}
console.log(`cdp errors: ${errCount}`);
ws.close();
console.log("=== E2E2 DONE ===");
process.exit(0);
