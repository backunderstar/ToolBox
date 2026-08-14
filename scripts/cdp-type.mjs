// CDP typing test: focus Vditor IR editor, dispatch real key events, verify content changes.
const PORT = process.argv[2] ?? "9223";
const URL = process.argv[3] ?? "http://localhost:1420/debug-editor.html";

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
  } else if (m.method) events.push(m);
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send("Runtime.enable");
console.log("[type] waiting for init...");
await new Promise((r) => setTimeout(r, 6000));

const lenExpr = `(() => {
  const ir = document.querySelector('.vditor-ir');
  const ta = document.querySelector('.vditor-ir textarea, textarea.vditor-ir__input');
  return JSON.stringify({
    textLen: ir ? ir.innerText.length : -1,
    hasTextarea: !!ta,
    taLen: ta ? ta.value.length : -1,
    irHTML: ir ? ir.innerHTML.slice(0, 200) : ''
  });
})()`;

const readState = async () => {
  const r = await send("Runtime.evaluate", { expression: lenExpr, returnByValue: true });
  return JSON.parse(r.result.result.value);
};

const before = await readState();
console.log("BEFORE:", JSON.stringify(before));

// Real-user flow: mouse click into editor, then type
const rectRes = await send("Runtime.evaluate", {
  expression: `(() => {
    const pre = document.querySelector('.vditor-ir pre.vditor-reset');
    if (!pre) return null;
    const r = pre.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });
  })()`,
  returnByValue: true,
});
const rect = JSON.parse(rectRes.result.result.value);
if (rect) {
  const { x, y } = rect;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 600));
}

const active = await send("Runtime.evaluate", {
  expression: `(() => {
    const el = document.activeElement;
    return JSON.stringify({ tag: el ? el.tagName : null, cls: el ? el.className : null, editable: el ? el.isContentEditable : null });
  })()`,
  returnByValue: true,
});
console.log("ACTIVE ELEMENT:", active.result.result.value);

// dispatch real key events for "abc"
for (const ch of ["a", "b", "c"]) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: ch,
    code: "Key" + ch.toUpperCase(),
    text: ch,
    windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
  });
  await send("Input.dispatchKeyEvent", {
    type: "char",
    text: ch,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: ch,
    code: "Key" + ch.toUpperCase(),
    windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
  });
  await new Promise((r) => setTimeout(r, 150));
}
await new Promise((r) => setTimeout(r, 1000));

const after = await readState();
console.log("AFTER :", JSON.stringify(after));
console.log("TYPED OK:", after.textLen > before.textLen || after.taLen > before.taLen);

// dump any exceptions
for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") {
    console.log("[exception]", ev.params.exceptionDetails.text, ev.params.exceptionDetails.exception?.description ?? "");
  }
}
ws.close();
process.exit(0);
