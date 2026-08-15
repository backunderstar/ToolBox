// Debug AI send flow in mock.
const PORT = process.argv[2] ?? "9225";
const URL = "http://localhost:1420/?mock=1";
const target = await fetch(`http://localhost:${PORT}/json/new?` + encodeURIComponent(URL), { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error(e.message)); });
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
  else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);
await evalJs(`(() => { const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.includes('AI')); b?.click(); return 'ok'; })()`);
await sleep(600);

// Step-by-step
console.log("btn before:", await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.ai-input-row .btn-primary-ai')][0];
  return btn ? JSON.stringify({ exists: true, disabled: btn.disabled, text: btn.textContent }) : 'NO_BTN';
})()`));

console.log("set+dispatch:", await evalJs(`(async () => {
  const input = document.querySelector('.ai-chat-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '你好');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const btn = [...document.querySelectorAll('.ai-input-row .btn-primary-ai')][0];
  return JSON.stringify({ inputValue: input.value, btnDisabled: btn?.disabled });
})()`));

console.log("click:", await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.ai-input-row .btn-primary-ai')][0];
  btn?.click();
  return 'clicked';
})()`));
await sleep(1500);
console.log("after:", await evalJs(`(() => JSON.stringify({
  msgCount: document.querySelectorAll('.ai-msg').length,
  last: document.querySelector('.ai-msg:last-child .ai-msg-content')?.textContent?.slice(0, 60),
  bodyHasError: document.body.textContent.includes('未配置 API Key')
}))()`));

console.log("--- events ---");
for (const ev of events) {
  if (ev.method === "Runtime.consoleAPICalled" && (ev.params.type === "error" || ev.params.type === "warning")) {
    console.log(`[${ev.params.type}]`, ev.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 120));
  }
}
ws.close();
process.exit(0);
