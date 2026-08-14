// CDP inspect: open URL in headless Edge, dump layout metrics + computed colors.
// Usage: node scripts/cdp-inspect.mjs [port] [url] [waitSec]
const PORT = process.argv[2] ?? "9224";
const URL = process.argv[3] ?? "http://localhost:1420/?mock=1";
const WAIT_SEC = Number(process.argv[4] ?? 10);

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
console.log(`[inspect] ${URL} — waiting ${WAIT_SEC}s...`);
await new Promise((r) => setTimeout(r, WAIT_SEC * 1000));

const probe = `(() => {
  const gs = (s, p) => { const el = document.querySelector(s); return el ? getComputedStyle(el)[p] : null; };
  const rect = (s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width) }; };
  const el = (s) => { const e = document.querySelector(s); return e ? { tag: e.tagName, cls: e.className } : null; };
  return JSON.stringify({
    viewport: { h: innerHeight, w: innerWidth },
    layout: {
      body: rect('.body'), main: rect('.main'), notes: rect('.notes'),
      filesPane: rect('.files-pane'), editorArea: rect('.editor-area'),
      editorHeader: rect('.editor-header'), editorBody: rect('.editor-body'),
      vditor: rect('.vditor'), content: rect('.vditor-content'), ir: rect('.vditor-ir'),
    },
    colors: {
      bodyBg: gs('body', 'backgroundColor'),
      topbarBg: gs('.topbar', 'backgroundColor'),
      toolbarBg: gs('.vditor-toolbar', 'backgroundColor'),
      contentBg: gs('.vditor-content', 'backgroundColor'),
      irBg: gs('.vditor-ir', 'backgroundColor'),
      irColor: gs('.vditor-ir', 'color'),
      irPadding: gs('.vditor-ir', 'padding'),
      irMaxWidth: gs('.vditor-ir', 'maxWidth'),
      irFontSize: gs('.vditor-reset', 'fontSize'),
      headingColor: gs('.vditor-ir h1', 'color'),
      codeBg: gs('.vditor-ir pre code', 'backgroundColor'),
      quoteColor: gs('.vditor-ir blockquote', 'color'),
      linkColor: gs('.vditor-ir a', 'color'),
    },
    themeVars: (() => {
      const v = document.querySelector('.vditor');
      const s = v ? getComputedStyle(v) : null;
      const get = (n) => (s ? s.getPropertyValue(n).trim() : null);
      return {
        toolbarBg: get('--toolbar-background-color'),
        iconColor: get('--toolbar-icon-color'),
        iconHover: get('--toolbar-icon-hover-color'),
        panelBg: get('--panel-background-color'),
        irHeading: get('--ir-heading-color'),
        irLink: get('--ir-link-color'),
        irBi: get('--ir-bi-color'),
        border: get('--border-color'),
        blockquote: get('--blockquote-color'),
        calloutNote: get('--callout-note-color'),
      };
    })(),
    editor: {
      hasVditor: !!document.querySelector('.vditor'),
      hasIr: !!document.querySelector('.vditor-ir'),
      editable: (document.querySelector('.vditor-ir pre.vditor-reset')?.getAttribute('contenteditable')) ?? null,
      toolbarButtons: document.querySelectorAll('.vditor-toolbar button').length,
    },
    myRule: (() => {
      let out = [];
      for (const sh of document.styleSheets) {
        try {
          for (const r of sh.cssRules) {
            if (r.selectorText === '.editor-host .vditor') {
              out.push({ src: sh.href ?? 'inline', text: r.cssText.slice(0, 200) });
            }
          }
        } catch { /* cross-origin sheet */ }
      }
      return out;
    })(),
    errs: window.__errs ?? null
  });
})()`;

const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
const v = JSON.parse(r.result.result.value);
console.log("=== VIEWPORT ===", JSON.stringify(v.viewport));
console.log("=== LAYOUT ===", JSON.stringify(v.layout, null, 0));
console.log("=== COLORS ===", JSON.stringify(v.colors, null, 0));
console.log("=== THEME VARS ===", JSON.stringify(v.themeVars, null, 0));
console.log("=== MY RULE PRESENT ===", JSON.stringify(v.myRule));

for (const ev of events) {
  if (ev.method === "Runtime.exceptionThrown") {
    console.log("[exception]", ev.params.exceptionDetails.text, ev.params.exceptionDetails.exception?.description ?? "");
  }
}
ws.close();
console.log("=== DONE ===");
process.exit(0);
