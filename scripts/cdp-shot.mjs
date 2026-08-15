// Screenshot the plugins view (mock mode) via CDP.
// Usage: node scripts/cdp-shot.mjs <outfile.png> [port]
import { writeFileSync } from "node:fs";
const OUT = process.argv[2] ?? "plugins-view.png";
const PORT = process.argv[3] ?? "9225";
const URL = "http://localhost:1420/?mock=1";

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
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 4000));
await send("Runtime.evaluate", {
  expression: `(() => { const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.includes('插件')); b&&b.click(); return 'ok'; })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 800));
await send("Runtime.evaluate", {
  expression: `(() => { const b=document.querySelector('.command-try'); b&&b.click(); return 'ok'; })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 400));
await send("Runtime.evaluate", {
  expression: `(() => { const btn=[...document.querySelectorAll('.try-head .btn')].find(b=>b.textContent.includes('运行')); btn&&btn.click(); return 'ok'; })()`,
  returnByValue: true,
});
await new Promise((r) => setTimeout(r, 600));

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
console.log("saved", OUT);
ws.close();
process.exit(0);
