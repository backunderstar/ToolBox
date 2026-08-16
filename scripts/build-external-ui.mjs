// 通用：构建外部插件自带前端（ui/index.tsx → 自包含 IIFE，React 打进产物）。
// 用法：node scripts/build-external-ui.mjs <插件目录>    （相对仓库根，如 plugins/text-stats）
// 产物复制回 <插件目录>/ui/（index.js + style.css），配合 plugin.json 的 ui.entry 使用。
// 与 core-plugins 的构建同一套模式（见 scripts/build-core.mjs 的 buildPluginUi）。
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDirArg = process.argv[2];
if (!pluginDirArg) {
  console.error("用法: node scripts/build-external-ui.mjs <插件目录>（如 plugins/text-stats）");
  process.exit(1);
}
const abs = path.resolve(root, pluginDirArg);
const entry = path.join(abs, "ui", "index.tsx");
const outDir = path.join(root, "target", "external-ui", path.basename(abs));
rmSync(outDir, { recursive: true, force: true });
await viteBuild({
  configFile: false,
  root,
  plugins: [react()],
  // React 开发版引用 process.env.NODE_ENV：lib 构建需显式替换（否则运行时 ReferenceError）
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  build: {
    outDir,
    emptyOutDir: true,
    lib: { entry, formats: ["iife"], name: "TBPluginUi" },
    rollupOptions: { output: { entryFileNames: "index.js", assetFileNames: "style.css" } },
  },
});
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
