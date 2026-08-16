// 版本历史 E2E：初始化 → 初始提交 → 编辑笔记 → 防抖自动提交 → 回滚到初始版本 → 内容恢复
import { rmSync } from "node:fs";

const PORT = process.argv[2] ?? "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
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
  if (r.result?.exceptionDetails) return "EXC:" + r.result.exceptionDetails.text;
  return r.result?.result?.value;
};
const clickByText = async (text) => {
  const t = JSON.stringify(text);
  return ev(`(() => { const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(${t})); if (el) { el.click(); return true; } return false; })()`);
};
const hasText = async (text) => {
  const t = JSON.stringify(text);
  return ev(`document.body.textContent.includes(${t})`);
};
const invoke = (cmd, args) => {
  const a = JSON.stringify(args ?? {});
  return ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${a}).then(r => JSON.stringify(r)).catch(e => 'ERR:' + e)`);
};
const waitFor = async (expr, timeoutMs = 15000, interval = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ev(expr)) return true;
    await sleep(interval);
  }
  return false;
};

await send("Runtime.enable");
await sleep(800);

// 1. 拿 vault 路径并清掉旧 .git（保证"启用版本历史"路径可测）
const vaultPath = await invoke("vault_get").then((r) => JSON.parse(r).path);
if (!vaultPath) { console.error("[history-e2e] no vault"); process.exit(1); }
console.log("[vault]", vaultPath);
rmSync(vaultPath + "/.git", { recursive: true, force: true });

// 2. 侧边栏进入版本历史视图（等初始化卡片出现：视图轮询刷新状态需要时间）
await clickByText("版本历史");
const initCard = await waitFor(`!!document.querySelector('.history-init-card')`);
console.log("[init-card]", initCard ? "OK" : "MISSING");
if (!initCard) process.exit(1);

// 3. 启用版本历史 → 应出现初始提交
await clickByText("启用版本历史");
const hasRoot = await waitFor(`document.body.textContent.includes('初始版本')`);
console.log("[root-commit]", hasRoot ? "OK" : "MISSING");
if (!hasRoot) process.exit(1);

// 4. 读原内容 → 写入新内容（时间戳保证与当前不同，真实产生变更）
const orig = await invoke("fs_read", { vault: vaultPath, rel: "notes/示例笔记.md" });
console.log("[orig-content]", JSON.stringify(orig).slice(0, 60));
const newContent = `# 版本历史自动提交测试 ${Date.now()}\n\n修改于 E2E。`;
await invoke("fs_write", { vault: vaultPath, rel: "notes/示例笔记.md", content: newContent });
await sleep(18000); // 防抖 15s + 提交余量

// 5. 刷新视图，断言"自动保存"提交出现在提交列表里（避免匹配静态文案）
await clickByText("刷新");
const hasAuto = await waitFor(
  `[...document.querySelectorAll('.history-msg')].some(e => e.textContent.includes('自动保存'))`,
  8000
);
console.log("[auto-commit]", hasAuto ? "OK" : "MISSING");
if (!hasAuto) process.exit(1);

// 6. 展开"初始版本"提交 → 回滚
const expanded = await ev(`(() => { const head = [...document.querySelectorAll('.history-commit-head')].find(b => b.textContent.includes('初始版本')); if (head) { head.click(); return true; } return false; })()`);
await sleep(1000);
console.log("[expand]", expanded ? "OK" : "FAIL");
const filesShown = await ev(`[...document.querySelectorAll('.history-files-list li')].length`);
console.log("[files-in-commit]", filesShown);
await clickByText("回滚到此版本");
await sleep(600);
const confirmVisible = await ev(`!!document.querySelector('.confirm-dialog')`);
console.log("[confirm-dialog]", confirmVisible ? "OK" : "MISSING");
// 精确点弹窗里的确认按钮（"回滚"），避免误点提交行里的"回滚到此版本"
await ev(`(() => { const el = [...document.querySelectorAll('.confirm-dialog button')].find(b => b.textContent.trim() === '回滚'); if (el) { el.click(); return true; } return false; })()`);
await sleep(2000);

// 7. 断言内容已恢复
const after = await invoke("fs_read", { vault: vaultPath, rel: "notes/示例笔记.md" });
console.log("[after-rollback]", JSON.stringify(after).slice(0, 60));
const restored = after === orig;
console.log("[restored]", restored ? "OK" : "FAIL");
if (!restored) process.exit(1);

// 8. 侧边栏仍有版本历史项（导航注册）
const navOk = await ev(`[...document.querySelectorAll('.nav-item')].some(b => b.textContent.includes('版本历史'))`);
console.log("[nav-item]", navOk ? "OK" : "MISSING");

ws.close();
console.log(restored && navOk && initCard && hasRoot && hasAuto ? "HISTORY_E2E_PASS" : "HISTORY_E2E_FAIL");
process.exit(restored && navOk && initCard && hasRoot && hasAuto ? 0 : 1);
