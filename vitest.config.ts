// vitest 独立配置：不继承 vite.config.ts（vite-plus 的 defineConfig 不含 test 字段，
// vitest 检测到 vitest.config.ts 存在时不会加载 vite.config.ts）。
// 前端测试策略：只覆盖纯函数/纯逻辑（themes / navPrefs / blogfm 等），不测组件——
// 避开 Vditor / WebView / Tauri 环境；环境用 node + 测试内手动 mock localStorage
// （themes 需要），无需 jsdom。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
