// plugin-ui-build.mjs — 插件自带前端（ui/index.ts → 自包含 IIFE，Vue 3 打进产物）
// 的公共构建器。core-plugins（build-core.mjs）与外部插件（build-external-ui.mjs）
// 共用同一套 vite lib 构建逻辑，避免两处漂移。
import { build as viteBuild } from "vite";
import vue from "@vitejs/plugin-vue";
import { rmSync } from "node:fs";

/**
 * 构建插件自带前端。
 * @param {object} opts
 * @param {string} opts.root      仓库根（vite root，别名/配置基准）
 * @param {string} opts.entry     ui/index.ts 绝对路径
 * @param {string} opts.outDir    产物目录（绝对路径，先清空）
 * @param {"development"|"production"} [opts.env] NODE_ENV（md-editor-v3 等依赖
 *        引用 process.env.NODE_ENV，lib 构建需显式替换否则运行时 ReferenceError）
 * @returns {Promise<string>} outDir（产物：index.js + style.css）
 */
export async function buildPluginUi({ root, entry, outDir, env = "production" }) {
  rmSync(outDir, { recursive: true, force: true });
  await viteBuild({
    configFile: false,
    root,
    plugins: [vue()],
    define: { "process.env.NODE_ENV": JSON.stringify(env) },
    build: {
      outDir,
      emptyOutDir: true,
      lib: { entry, formats: ["iife"], name: "TBPluginUi" },
      rollupOptions: { output: { entryFileNames: "index.js", assetFileNames: "style.css" } },
    },
  });
  return outDir;
}
