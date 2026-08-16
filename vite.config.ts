import { defineConfig } from "vite";
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
        // 与应用代码分离，便于缓存与并行加载
        manualChunks: {
          vditor: ["vditor"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
