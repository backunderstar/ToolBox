// build.mjs — 构建本插件的自带前端（ui/index.ts → ui/index.js + style.css，自包含 IIFE）。
// 用法：npm install && npm run build（产物写回 ui/，生成物勿手改）。
// 逻辑与 ToolBox 仓库 scripts/plugin-ui-build.mjs 一致（vite lib 模式 + Vue 插件），
// 独立插件项目自带，不依赖 ToolBox 仓库。
import { build } from "vite";
import vue from "@vitejs/plugin-vue";
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, "ui", "index.ts");
const outDir = path.join(root, "target", "ui-build");

rmSync(outDir, { recursive: true, force: true });
await build({
  configFile: false,
  root,
  plugins: [vue()],
  // md-editor-v3 等依赖运行时引用 process.env，lib 构建需显式替换否则 ReferenceError
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir,
    emptyOutDir: true,
    lib: { entry, formats: ["iife"], name: "TBPluginUi" },
    rollupOptions: { output: { entryFileNames: "index.js", assetFileNames: "style.css" } },
  },
});
// 产物复制回插件目录 ui/（与 ToolBox 的 build-external-ui 一致）
for (const f of ["index.js", "style.css"]) {
  try {
    cpSync(path.join(outDir, f), path.join(root, "ui", f));
    console.log(`[build] 已生成 ui/${f}`);
  } catch {
    /* 无该产物（如无样式） */
  }
}
rmSync(outDir, { recursive: true, force: true });
console.log("[build] 完成");
