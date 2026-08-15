// Inspect what the browser actually loaded for checklists.tsx
const PORT = process.argv[2] ?? "9226";
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
console.log("targets:", targets.map((t) => `${t.type} ${t.url} ${t.id.slice(0, 8)}`));
const page = targets.find((t) => t.type === "page" && /localhost:1420/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(e.message)); });
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
console.log("module has fsListDir:", await evalJs(
  `fetch('/src/core/checklists.tsx?x=' + Date.now()).then(r => r.text()).then(t => t.includes('fsListDir'))`
));
console.log("module has bare fsList ref:", await evalJs(
  `fetch('/src/core/checklists.tsx?x=' + Date.now()).then(r => r.text()).then(t => /[^D]fsList[^D]/.test(t))`
));
console.log("window location:", await evalJs(`location.href`));
// what module versions does the browser have loaded?
const mods = await evalJs(`(() => {
  try {
    return JSON.stringify([...performance.getEntriesByType('resource')].filter(r => r.name.includes('checklists')).map(r => r.name.split('?')[1]))
  } catch(e) { return 'ERR:' + e }
})()`);
console.log("loaded checklists resources:", mods);
ws.close();
process.exit(0);
