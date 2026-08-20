// 通用：构建外部插件自带前端（ui/index.tsx → 自包含 IIFE，React 打进产物）。
// 用法：node scripts/build-external-ui.mjs <插件目录>    （相对仓库根，如 plugins/text-stats）
// 产物复制回 <插件目录>/ui/（index.js + style.css），配合 plugin.json 的 ui.entry 使用。
// 构建逻辑与 core-plugins 共用（scripts/plugin-ui-build.mjs，见 build-core.mjs）。
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginUi } from "./plugin-ui-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDirArg = process.argv[2];
if (!pluginDirArg) {
  console.error("用法: node scripts/build-external-ui.mjs <插件目录>（如 plugins/text-stats）");
  process.exit(1);
}
const abs = path.resolve(root, pluginDirArg);
const entry = path.join(abs, "ui", "index.tsx");
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
