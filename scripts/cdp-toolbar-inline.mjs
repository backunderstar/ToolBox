// 检查工具栏 inline style
const targets = await fetch("http://localhost:9226/json").then((r) => r.json());
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
const out = await ev(`(() => {
  const tb = document.querySelector('.editor-host .vditor-toolbar');
  const styles = [];
  for (let i = 0; i < tb.style.length; i++) { const k = tb.style[i]; styles.push(k + '=' + tb.style.getPropertyValue(k)); }
  // 检查所有匹配 cssText 含 padding 的样式规则
  const matched = [];
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = [...sheet.cssRules]; } catch (e) { continue; }
    for (const rule of rules) {
      if (rule.selectorText && rule.selectorText.includes('vditor-toolbar') && rule.style && rule.style.padding) {
        matched.push(rule.selectorText + ' { padding: ' + rule.style.padding + ' }');
      }
    }
  }
  return JSON.stringify({ inlineStyle: styles, matchedRules: matched });
})()`);
console.log(out);
ws.close();
process.exit(0);
