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
    // 目标：WebView2 固定基于 Chromium 120+，可按现代浏览器语法输出更小的包
    // （无需兼容旧浏览器，避免 Vite 默认的保守转译）。
    // 不做 manualChunks 分包：旧规则因 pnpm 的 node_modules/.pnpm/ 路径结构
    // 从未匹配成功（死代码），且 Tauri 桌面应用整包更新、无 HTTP 缓存场景，
    // JS 分包没有收益（首屏 parse 本地 250KB 级 bundle 开销可忽略）。
    target: "chrome120",
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
