// Vite+ 配置：Vite+ 是 Vite 8（rolldown）的超集 CLI，
// defineConfig 从 "vite-plus" 导入即可同时使用标准 Vite 配置块与 Vite+ 专属块（lint/fmt/check）。
import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

// Tauri 2 + Vite 配置：端口固定为 1420（与 src-tauri/tauri.conf.json 的 devUrl 一致）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // 忽略 Rust 侧与文件写入工具的临时文件（避免 EBUSY 崩溃）；
      // workspace 化后 cargo target 在仓库根，必须显式忽略
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/.git/**",
        "**/.*.tmpdir/**",
        "**/*.tmp",
        "**/*.log",
      ],
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 分包：vditor（体积大、更新频率低）与 react 单独成 chunk，
        // 与应用代码分离，便于缓存与并行加载。
        // 注意：rolldown（Vite 8 默认打包器）只接受函数形式的 manualChunks，
        // 不接受 rollup 的 { 包名: ["模块id"] } 对象形式
        manualChunks(id) {
          const m = id.replace(/\\/g, "/").match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
          const pkg = m?.[1] ?? "";
          if (pkg === "vditor") return "vditor";
          if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "react";
          return undefined;
        },
      },
    },
  },
  lint: {
    // vp lint / vp check 的 lint 范围：排除产物与 Rust 侧
    ignorePatterns: [
      "dist/**",
      "src-tauri/**",
      "target/**",
      "public/**",
      "docs/**",
      "plugins/*/ui/index.js",
    ],
  },
  fmt: {
    // oxfmt 默认扫全仓库（含压缩的 vditor 产物、中文文档、Cargo.toml），
    // 这里收窄到真正的源码，避免对第三方产物/文档产生无意义 diff
    ignorePatterns: [
      "dist/**",
      "src-tauri/**",
      "target/**",
      "public/**",
      "docs/**",
      "*.md",
      "**/Cargo.toml",
    ],
  },
});
