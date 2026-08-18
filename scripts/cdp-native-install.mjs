// cdp-native-install.mjs — 安装插件 E2E（手动 + 界面安装，通用 runtime）：
// 1) 手动放目录到 %APPDATA%/plugins/_core/ → 刷新自动识别为原生插件（就绪 + 命令可用）
// 2) 界面安装 .zip 包（plugins_install，PowerShell 构造 zip）
// 3) 界面安装插件目录（plugins_install kind=dir）
// 全部验证 DLL 真实加载，最后清理（不留残留）。
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMainPage, connect, sleep, helpers } from "./cdp-lib.mjs";

const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) {
  console.error("no main page");
  process.exit(1);
}
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);

const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const coreRoot = path.join(appData, "com.toolbox.desktop", "plugins", "_core");
const srcDir = path.join(coreRoot, "core-notes");
if (!existsSync(srcDir)) {
  console.error("缺少模板插件目录（先运行 pnpm build:core）: " + srcDir);
  process.exit(1);
}

/** 复制 core-notes 模板并改写清单 id，返回插件 id 与目录 */
function makePlugin(tag) {
  const id = `e2e-native-${tag}-${Date.now().toString(36)}`;
  const dir = path.join(coreRoot, id);
  cpSync(srcDir, dir, { recursive: true });
  const mp = path.join(dir, "plugin.json");
  const m = JSON.parse(readFileSync(mp, "utf8"));
  m.id = id;
  m.name = id;
  writeFileSync(mp, JSON.stringify(m, null, 2), "utf8");
  return { id, dir };
}

/** 断言插件出现在列表且状态"就绪"，随后调用其命令验证 DLL 真实加载 */
async function assertInstalled(id, vault) {
  await waitFor(
    `[...document.querySelectorAll('.plugin-card')].some(c => c.textContent.includes('${id}'))`,
    `插件 ${id} 被识别`,
    20000,
  );
  const status = await ev(`(() => {
    const card = [...document.querySelectorAll('.plugin-card')].find(c => c.textContent.includes('${id}'));
    return card?.querySelector('.badge-status')?.textContent ?? '(无)';
  })()`);
  if (status !== "就绪") throw new Error(`插件 ${id} 应加载 DLL 并就绪，实际: ${status}`);
  const cmdOk = await ev(`(async () => {
    try {
      const r = await window.__TAURI_INTERNALS__.invoke('plugin_call', { vault: ${JSON.stringify(vault)}, id: ${JSON.stringify(id)}, command: 'notes.list', args: {} });
      return Array.isArray(r) ? 'OK:' + r.length : 'ODD:' + JSON.stringify(r);
    } catch (e) { return 'ERR:' + String(e); }
  })()`);
  if (!cmdOk.startsWith("OK:")) throw new Error(`插件 ${id} 命令调用失败: ${cmdOk}`);
  return cmdOk;
}

/** 卸载插件（应用内卸载：Rust 先停进程释放 DLL 再删除目录）并刷新，等待其从列表消失 */
async function cleanup(id, vault) {
  const r = await ev(
    `window.__TAURI_INTERNALS__.invoke('plugins_uninstall', { vault: ${JSON.stringify(vault)}, id: ${JSON.stringify(id)} })`,
  );
  if (r !== null) throw new Error(`卸载 ${id} 失败: ${JSON.stringify(r)}`);
  await clickText(".view-actions button", "刷新");
  await waitFor(
    `![...document.querySelectorAll('.plugin-card')].some(c => c.textContent.includes('${id}'))`,
    `插件 ${id} 清理完成`,
    15000,
  );
}

// ---- 0. 重置导航配置（历史 E2E 可能隐藏了「插件」项）+ 进入插件页 + 拿 vault ----
await sleep(500);
await ev(`localStorage.removeItem('toolbox.nav'); location.reload(); true`);
await sleep(2500);
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
const vp = await ev(`window.__TAURI_INTERNALS__.invoke('vault_get')`);
const vault = vp?.path ?? "";
if (!vault) throw new Error("E2E 需先有工作区");
await clickText(".nav-item", "插件");
await waitFor(`!!document.querySelector('.plugin-card')`, "插件页出现");

// ---- 1. 手动安装：把 DLL 插件目录放入 _core → 刷新自动识别 ----
const m1 = makePlugin("manual");
log(`PASS 已把 DLL 插件目录放入 _core/${m1.id}（手动安装）`);
await clickText(".view-actions button", "刷新");
const c1 = await assertInstalled(m1.id, vault);
log(`PASS 手动安装插件自动识别并加载 DLL（${m1.id} · 命令 ${c1}）`);
await cleanup(m1.id, vault);
log("PASS 手动安装清理完成");

// ---- 2. 界面安装 .zip 包（plugins_install kind=zip）----
const zsrc = path.join(os.tmpdir(), `tb-e2e-zip-${Date.now().toString(36)}`);
const zid = `e2e-native-zip-${Date.now().toString(36)}`;
mkdirSync(path.join(zsrc, zid), { recursive: true });
cpSync(srcDir, path.join(zsrc, zid), { recursive: true });
{
  const mp = path.join(zsrc, zid, "plugin.json");
  const m = JSON.parse(readFileSync(mp, "utf8"));
  m.id = zid;
  m.name = zid;
  writeFileSync(mp, JSON.stringify(m, null, 2), "utf8");
}
const zfile = path.join(os.tmpdir(), `tb-e2e-${Date.now().toString(36)}.zip`);
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${zsrc}\\${zid}' -DestinationPath '${zfile}'"`,
  { stdio: "ignore" },
);
const zipInstalled = await ev(
  `window.__TAURI_INTERNALS__.invoke('plugins_install', { vault: ${JSON.stringify(vault)}, source: ${JSON.stringify(zfile)}, kind: 'zip' })`,
);
if (zipInstalled !== zid) throw new Error(`zip 安装返回异常: ${JSON.stringify(zipInstalled)}`);
await clickText(".view-actions button", "刷新");
const c2 = await assertInstalled(zid, vault);
log(`PASS 界面安装 .zip 包（${zid} · 命令 ${c2}）`);
await cleanup(zid, vault);
rmSync(zsrc, { recursive: true, force: true });
rmSync(zfile, { force: true });
log("PASS zip 安装清理完成");

// ---- 3. 界面安装插件目录（plugins_install kind=dir）----
const dsrc = path.join(os.tmpdir(), `tb-e2e-dir-${Date.now().toString(36)}`);
const did = `e2e-native-dir-${Date.now().toString(36)}`;
mkdirSync(dsrc, { recursive: true });
cpSync(srcDir, dsrc, { recursive: true });
{
  const mp = path.join(dsrc, "plugin.json");
  const m = JSON.parse(readFileSync(mp, "utf8"));
  m.id = did;
  m.name = did;
  writeFileSync(mp, JSON.stringify(m, null, 2), "utf8");
}
const dirInstalled = await ev(
  `window.__TAURI_INTERNALS__.invoke('plugins_install', { vault: ${JSON.stringify(vault)}, source: ${JSON.stringify(dsrc)}, kind: 'dir' })`,
);
if (dirInstalled !== did) throw new Error(`目录安装返回异常: ${JSON.stringify(dirInstalled)}`);
await clickText(".view-actions button", "刷新");
const c3 = await assertInstalled(did, vault);
log(`PASS 界面安装插件目录（${did} · 命令 ${c3}）`);
await cleanup(did, vault);
rmSync(dsrc, { recursive: true, force: true });
log("PASS 目录安装清理完成");

log("\n========== NATIVE_INSTALL_E2E_PASS ==========");
process.exit(0);
