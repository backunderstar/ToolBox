// cdp-lib.mjs — E2E 公共工具：CDP 目标选择（主窗口/浮窗）与 WebSocket 连接。
// 浮窗是独立 WebView，也注册为 page target；所有脚本必须先区分，避免连错窗口。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 探测页面是否包含 .float-window（浮窗插件 UI 根） */
async function probe(page, expression) {
  try {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const r = await new Promise((res) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === 1) res(m);
      };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    ws.close();
    return r.result?.result?.value === true;
  } catch {
    return false;
  }
}

/** 找到主窗口 page target（排除浮窗） */
export async function findMainPage(port) {
  const targets = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
  const pages = targets.filter((t) => t.type === "page");
  for (const cand of pages) {
    if (!(await probe(cand, "!!document.querySelector('.float-window')"))) return cand;
  }
  return pages[0] ?? null;
}

/** 找到浮窗 page target */
export async function findFloatPage(port) {
  const targets = await fetch(`http://localhost:${port}/json`).then((r) => r.json());
  for (const cand of targets.filter((t) => t.type === "page")) {
    if (await probe(cand, "!!document.querySelector('.float-window')")) return cand;
  }
  return null;
}

/** 连接页面：返回 { ev, ws }（ev 求值表达式，awaitPromise 支持 async 表达式） */
export async function connect(page) {
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
    if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
    return r.result?.result?.value;
  };
  await send("Runtime.enable");
  return { ws, ev };
}
