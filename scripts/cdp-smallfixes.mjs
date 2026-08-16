// 审计小项 E2E：1) 重命名非法字符前端校验 2) 博客站点过期提示
const PORT = process.argv[2] ?? "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
const page = targets.find((t) => t.type === "page" && /1420|tauri/.test(t.url)) ?? targets.find((t) => t.type === "page");
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
const waitFor = async (expr, timeoutMs = 15000, interval = 400) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ev(expr)) return true;
    await sleep(interval);
  }
  return false;
};
const clickNav = async (label) => {
  await ev(`(() => { const b = [...document.querySelectorAll('.sidebar .nav-item')].find(x => x.textContent.includes(${JSON.stringify(label)})); if (b) b.click(); return !!b; })()`);
  await sleep(1000);
};
const statusMsg = () => ev(`document.querySelector('.status-msg')?.textContent ?? ''`);

await send("Runtime.enable");
await sleep(1000);

/* ===== 1. 重命名非法字符校验 ===== */
await clickNav("笔记");
// 双击第一个文件进入重命名
const dbl = await ev(`(() => {
  const name = document.querySelector('.tree-name');
  if (!name) return false;
  name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  return true;
})()`);
console.log("[rename] dblclick:", dbl ? "OK" : "FAIL");
const inputShown = await waitFor(`!!document.querySelector('.tree-input')`);
console.log("[rename] input:", inputShown ? "OK" : "FAIL");
// 输入非法字符 "a:b" 并回车
await ev(`(() => {
  const input = document.querySelector('.tree-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'a:b');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`);
await sleep(800);
const msg = await statusMsg();
const badNameGone = await ev(`![...document.querySelectorAll('.tree-name')].some(n => n.textContent.trim() === 'a:b.md')`);
console.log("[rename] status:", JSON.stringify(msg));
console.log("[rename] no-bad-file:", badNameGone ? "OK" : "FAIL");
const renameOk = msg.includes("非法字符") && badNameGone;

/* ===== 2. 博客站点过期提示 ===== */
const vaultPath = await ev(`window.__TAURI_INTERNALS__.invoke('vault_get').then(v => v.path)`);
if (!vaultPath) { console.error("no vault"); process.exit(1); }
await clickNav("博客发布");
// 生成站点
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('生成站点')); if (b) b.click(); return !!b; })()`);
const genDone = await waitFor(`document.body.textContent.includes('站点已生成')`, 20000);
console.log("[blog] generate:", genDone ? "OK" : "FAIL");
// 修改已发布笔记（保留 frontmatter，内容追加一行）
await ev(`window.__TAURI_INTERNALS__.invoke('fs_read', { vault: ${JSON.stringify(vaultPath)}, rel: 'notes/博客文章.md' }).then(async (c) => {
  await window.__TAURI_INTERNALS__.invoke('fs_write', { vault: ${JSON.stringify(vaultPath)}, rel: 'notes/博客文章.md', content: c + '\\nE2E 过期测试修改。' });
  return true;
})`);
// 切走再切回博客视图（触发 mount 刷新）
await clickNav("概览");
await clickNav("博客发布");
const staleShown = await waitFor(`!!document.querySelector('.settings-message.warn')`, 10000);
const staleText = await ev(`document.querySelector('.settings-message.warn')?.textContent ?? ''`);
console.log("[blog] stale-banner:", staleShown ? "OK" : "MISSING");
console.log("[blog] stale-text:", JSON.stringify(staleText.slice(0, 60)));
const blogOk = staleShown && staleText.includes("更新过");

ws.close();
console.log(renameOk && blogOk ? "SMALLFIXES_PASS" : "SMALLFIXES_FAIL");
process.exit(renameOk && blogOk ? 0 : 1);
