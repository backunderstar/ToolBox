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
      // 忽略 Rust 侧与文件写入工具的临时文件（避免 EBUSY 崩溃）
      ignored: [
        "**/src-tauri/**",
        "**/.git/**",
        "**/.*.tmpdir/**",
        "**/*.tmp",
        "**/*.log",
      ],
    },
  },
});
