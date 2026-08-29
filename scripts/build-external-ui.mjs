// 通用：构建外部插件自带前端（ui/index.ts → 自包含 IIFE，Vue 3 打进产物；
// 兼容遗留 index.tsx 入口）。
// 用法：node scripts/build-external-ui.mjs <插件目录>    （相对仓库根，如 plugins/xxx）
// 产物复制回 <插件目录>/ui/（index.js + style.css），配合 plugin.json 的 ui.entry 使用。
// 构建逻辑与 core-plugins 共用（scripts/plugin-ui-build.mjs，见 build-core.mjs）。
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginUi } from "./plugin-ui-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDirArg = process.argv[2];
if (!pluginDirArg) {
  console.error("用法: node scripts/build-external-ui.mjs <插件目录>（如 plugins/xxx）");
  process.exit(1);
}
const abs = path.resolve(root, pluginDirArg);
const entryTs = path.join(abs, "ui", "index.ts");
const entryTsx = path.join(abs, "ui", "index.tsx");
const entry = existsSync(entryTs) ? entryTs : entryTsx;
const outDir = path.join(root, "target", "external-ui", path.basename(abs));
await buildPluginUi({ root, entry, outDir, env: "development" });
// 复制回插件目录 ui/
const uiTarget = path.join(abs, "ui");
mkdirSync(uiTarget, { recursive: true });
for (const f of ["index.js", "style.css"]) {
  try {
    cpSync(path.join(outDir, f), path.join(uiTarget, f));
    console.log(`[build-external-ui] 已部署: ${pluginDirArg}/ui/${f}`);
  } catch {
    /* 无该产物（如无样式） */
  }
}
console.log(`[build-external-ui] 完成: ${pluginDirArg}`);
