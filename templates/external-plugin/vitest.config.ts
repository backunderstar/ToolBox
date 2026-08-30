// 模板前端测试配置：vitest + jsdom（挂载 App.vue 需要 DOM）。
// 测什么：① 自带前端入口契约（window.__TB_PLUGIN_UI__[id].mount/unmount）
//        ② App.vue 界面行为（api.call / api.on / host.search，全部用 mock api）
// 不测：Python 进程协议（那是 test/mock-host.py 的职责）、真实宿主注入（回宿主冒烟）。
import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
