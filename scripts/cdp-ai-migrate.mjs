// 干净迁移测试：写旧格式 ai.json → ai_config_get → 验证凭据与明文清除
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const aiPath = `${process.env.APPDATA}\\com.toolbox.desktop\\ai.json`;
const oldFormat = JSON.stringify({ baseUrl: "https://api.deepseek.com", model: "old-model", apiKey: "sk-OLD-PLAINTEXT-999" });
writeFileSync(aiPath, oldFormat, "utf8");
console.log("已写旧格式:", oldFormat);

const t = await fetch("http://localhost:9226/json").then((r) => r.json());
const page = t.find((x) => x.type === "page" && /1420/.test(x.url));
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
await send("Runtime.enable");
const r = await send("Runtime.evaluate", {
  expression: `window.__TAURI_INTERNALS__.invoke('ai_config_get').then(v => JSON.stringify(v)).catch(e => 'ERR:' + e)`,
  returnByValue: true,
  awaitPromise: true,
});
console.log("ai_config_get:", r.result?.result?.value);
await new Promise((res) => setTimeout(res, 500));
console.log("迁移后 ai.json:", readFileSync(aiPath, "utf8"));
const creds = execSync("cmdkey /list", { encoding: "utf8" });
console.log("凭据管理器 toolbox 条目:", creds.split("\n").filter((l) => l.includes("toolbox")).join(" | ") || "(无)");
ws.close();
process.exit(0);
