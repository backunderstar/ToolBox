// cdp-lib.mjs — E2E 公共工具：CDP 目标选择（主窗口/浮窗）与 WebSocket 连接。
// 浮窗是独立 WebView，也注册为 page target；所有脚本必须先区分，避免连错窗口。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 探测页面是否包含 .float-window（浮窗插件 UI 根） */
async function probe(page, expression) {
  try {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    const r = await new Promise((res) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === 1) res(m);
      };
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }),
      );
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
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const cb = pending.get(m.id);
      if (cb) {
        pending.delete(m.id);
        cb(m);
      }
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
    return r.result?.result?.value;
  };
  await send("Runtime.enable");
  return { ws, ev };
}

/** E2E 公共辅助（绑定 ev 求值器）：waitFor / clickText / log。
 * 各脚本统一从这里取，不再各自复制一份（历史：多数脚本各 15 行样板）。 */
export function helpers(ev) {
  return {
    /** 轮询等待表达式为真（默认 30s/400ms） */
    waitFor: async (expr, desc, timeoutMs = 30000, interval = 400) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await ev(expr)) return true;
        await sleep(interval);
      }
      throw new Error(`超时等待: ${desc}`);
    },
    /** 点击文本匹配的元素（selector 内第一个 textContent === text 的） */
    clickText: async (selector, text) => {
      const ok = await ev(
        `(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = els.find(e => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (!ok) throw new Error(`未找到可点元素 ${selector}「${text}」`);
    },
    log: (s) => console.log(s),
  };
}

/**
 * 标准主窗口 E2E 环境：连接主窗口 page target + 绑定公共辅助。
 * 替换各脚本手写的「PORT 解析 + findMainPage + connect + helpers」样板
 * （历史 13 个脚本各重复 6 行；新增脚本直接用本函数）。
 * 返回 { ev, ws, waitFor, clickText, log, sleep, page, port }。
 */
export async function setupMain(portArg) {
  const port = portArg ?? "9226";
  const page = await findMainPage(port);
  if (!page) {
    console.error("no main page");
    process.exit(1);
  }
  const { ev, ws } = await connect(page);
  const { waitFor, clickText, log } = helpers(ev);
  return { ev, ws, waitFor, clickText, log, sleep, page, port };
}

/** 标准浮窗 E2E 环境（cdp-todos-ui 等浮窗场景）；语义同 setupMain。 */
export async function setupFloat(portArg) {
  const port = portArg ?? "9226";
  const page = await findFloatPage(port);
  if (!page) {
    console.error("no float page");
    process.exit(1);
  }
  const { ev, ws } = await connect(page);
  const { waitFor, clickText, log } = helpers(ev);
  return { ev, ws, waitFor, clickText, log, sleep, page, port };
}
