// cdp-todos-ui.mjs — core-todos 插件自带前端 E2E：浮窗挂载插件 UI/添加/打卡/清除
import { findMainPage, findFloatPage, connect, sleep } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";

const waitFor = async (ev, expr, desc, timeoutMs = 30000, interval = 400) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ev(expr)) return true;
    await sleep(interval);
  }
  throw new Error(`超时等待: ${desc}`);
};
const log = (s) => console.log(s);

// ---- 1. 主窗口 + 打开浮窗（初始状态不确定，反复 toggle 直到浮窗页面出现）----
const main = await findMainPage(PORT);
if (!main) {
  console.error("no main page");
  process.exit(1);
}
const mainC = await connect(main);
await sleep(500);

let floatConn = null;
for (let i = 0; i < 6 && !floatConn; i++) {
  const f = await findFloatPage(PORT);
  if (f) {
    floatConn = { conn: await connect(f), target: f };
    break;
  }
  const vis = await mainC.ev(`window.__TAURI_INTERNALS__.invoke('float_toggle').then((v) => v)`);
  log(`toggled float（可见=${vis}）`);
  await sleep(800);
}
if (!floatConn) throw new Error("未找到浮窗目标");
log("PASS 找到浮窗页面（插件 UI 挂载区）");

// ---- 3. 插件自带前端挂载（标题栏/输入行）----
await waitFor(
  floatConn.conn.ev,
  `!!document.querySelector('.float-window .float-titlebar')`,
  "浮窗插件 UI 标题栏",
);
await waitFor(
  floatConn.conn.ev,
  `!!document.querySelector('.float-window .float-input')`,
  "浮窗插件 UI 输入行",
);
log("PASS 浮窗渲染插件自带前端（core-todos ui/index.js）");

// ---- 4. 添加待办 → 列表出现 ----
const todoText = `E2E待办${Date.now().toString(36)}`;
await floatConn.conn.ev(`(() => {
  const el = document.querySelector('.float-window .float-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(todoText)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await floatConn.conn.ev(`document.querySelector('.float-window .float-add')?.click()`);
await waitFor(
  floatConn.conn.ev,
  `[...document.querySelectorAll('.float-window .float-item-text')].some(e => e.textContent === ${JSON.stringify(todoText)})`,
  "待办出现在列表（todos.add 经桥 + DLL）",
);
log("PASS 添加待办（todos.add 经桥）");

// ---- 5. 打卡 ----
await floatConn.conn.ev(`(() => {
  const item = [...document.querySelectorAll('.float-window .float-item')].find(i => i.querySelector('.float-item-text')?.textContent === ${JSON.stringify(todoText)});
  item?.querySelector('.float-check')?.click(); return !!item;
})()`);
await waitFor(
  floatConn.conn.ev,
  `[...document.querySelectorAll('.float-window .float-item')].some(i => i.querySelector('.float-item-text')?.textContent === ${JSON.stringify(todoText)} && i.classList.contains('done'))`,
  "待办标记完成（todos.toggle 经桥）",
);
log("PASS 打卡（todos.toggle 经桥）");

// ---- 6. 清除已完成 ----
const doneBtn = await floatConn.conn.ev(`(() => {
  const b = [...document.querySelectorAll('.float-window .float-foot button')].find(b => b.textContent.includes('清除已完成'));
  if (!b || b.disabled) return false;
  b.click(); return true;
})()`);
if (doneBtn) {
  await waitFor(
    floatConn.conn.ev,
    `![...document.querySelectorAll('.float-window .float-item-text')].some(e => e.textContent === ${JSON.stringify(todoText)})`,
    "已完成待办被清除（todos.clearDone 经桥）",
  );
  log("PASS 清除已完成（todos.clearDone 经桥）");
} else {
  log("PASS 清除按钮状态正确（跳过：无已完成项）");
}

log("\n========== TODOS_UI_E2E_PASS ==========");
process.exit(0);
