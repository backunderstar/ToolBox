// CDP cascade debug: why doesn't .editor-host .vditor variable override win?
const PORT = process.argv[2] ?? "9224";
const URL = process.argv[3] ?? "http://localhost:1420/?mock=1";

const target = await fetch(
  `http://localhost:${PORT}/json/new?` + encodeURIComponent(URL),
  { method: "PUT" }
).then((r) => r.json());
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { const cb = pending.get(m.id); if (cb) { pending.delete(m.id); cb(m); } }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Runtime.enable");
await new Promise((r) => setTimeout(r, 9000));

const probe = `(() => {
  const out = {};
  const host = document.querySelector('.editor-host');
  out.hostClass = host ? host.className : null;
  out.vditorInHost = !!document.querySelector('.editor-host .vditor');
  out.vditorCount = document.querySelectorAll('.vditor').length;
  const v = document.querySelector('.vditor');
  const read = () => v ? getComputedStyle(v).getPropertyValue('--toolbar-background-color').trim() : null;

  // order of style tags
  out.styleTags = [...document.querySelectorAll('style')].map((s, i) => {
    const first = s.textContent.slice(0, 60).replace(/\\n/g, ' ');
    return i + ': ' + first;
  });
  out.before = read();

  // test 1: same selector, !important
  const st1 = document.createElement('style');
  st1.textContent = '.editor-host .vditor { --toolbar-background-color: rgb(1,2,3) !important; }';
  document.head.appendChild(st1);
  out.test1Important = read();
  st1.remove();

  // test 2: same selector, no important (order check at same specificity)
  const st2 = document.createElement('style');
  st2.textContent = '.editor-host .vditor { --toolbar-background-color: rgb(4,5,6); }';
  document.head.appendChild(st2);
  out.test2SameSpec = read();
  st2.remove();

  // test 3: higher specificity
  const st3 = document.createElement('style');
  st3.textContent = '.editor-host .editor-body .vditor { --toolbar-background-color: rgb(7,8,9); }';
  document.head.appendChild(st3);
  out.test3HigherSpec = read();
  st3.remove();

  out.after = read();
  return JSON.stringify(out);
})()`;

const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
console.log(r.result.result.value);
ws.close();
process.exit(0);
