// CDP probe via Node built-in WebSocket.
// Usage: node scripts/cdp-probe.mjs [port] [url] [waitSec]
const PORT = process.argv[2] ?? "9223";
const URL = process.argv[3] ?? "http://localhost:1420/debug-editor.html";
const WAIT_SEC = Number(process.argv[4] ?? 8);

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
console.log(`[probe] listening on ${URL}, waiting ${WAIT_SEC}s...`);
await new Promise((r) => setTimeout(r, WAIT_SEC * 1000));

const probe = `(() => {
  const log = document.getElementById('log');
  const ir = document.querySelector('.vditor-ir');
  return JSON.stringify({
    url: location.href,
    log: log ? log.textContent : 'NOLOG',
    vditor: !!document.querySelector('.vditor'),
    ir: !!ir,
    contenteditable: ir ? ir.getAttribute('contenteditable') : null,
    toolbarButtons: document.querySelectorAll('.vditor-toolbar button').length,
    bodyLen: document.body ? document.body.innerText.length : -1
  });
})()`;

const res = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
const value = JSON.parse(res.result.result.value);
console.log("=== PAGE STATE ===");
console.log("URL:", value.url);
console.log(
  `vditor: ${value.vditor} | ir: ${value.ir} | contenteditable: ${value.contenteditable} | toolbarButtons: ${value.toolbarButtons}`
);
console.log("--- PAGE LOG ---");
console.log(value.log);

console.log("--- CONSOLE EVENTS ---");
for (const ev of events) {
  if (ev.method === "Runtime.consoleAPICalled") {
    const args = ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    console.log("[console]", args);
  }
  if (ev.method === "Runtime.exceptionThrown") {
    const d = ev.params.exceptionDetails;
    console.log("[exception]", d.text, "@", d.url ?? "", "line", d.lineNumber, "col", d.columnNumber);
    if (d.exception?.description) console.log("  ", d.exception.description.split("\n").slice(0, 8).join("\n   "));
  }
  if (ev.method === "Log.entryAdded") {
    console.log("[log]", ev.params.entry.level + ":", ev.params.entry.text);
  }
}
ws.close();
console.log("=== DONE ===");
process.exit(0);
