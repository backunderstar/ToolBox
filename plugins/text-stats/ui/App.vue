<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * text-stats 插件自带前端（组件模式）：文本统计工具页。
 * 演示"UI 经 api.call 调自己的命令"：统计逻辑在 main.js 的 registerCommand
 * （analyze）里，UI 只负责输入与展示——api.call 命中 webview 本地命令注册表
 * 本地执行（见 pluginRuntime.ts 的 localCommands 注释）。宿主注入 api 桥；
 * 样式复用宿主全局 CSS。
 */
interface TextStats {
  chars: number;
  words: number;
  lines: number;
  paragraphs: number;
}

const props = defineProps<{ api: PluginBridgeApi }>();

const text = ref("");
const stats = ref<TextStats | null>(null);
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

// 防抖（400ms）调 analyze 命令：真实走"UI → api.call → 本地注册表 → 命令"
watch(text, (t) => {
  const s = ++seq;
  if (!t.trim()) {
    stats.value = null;
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void props.api
      .call("analyze", { text: t })
      .then((r) => {
        if (s === seq) stats.value = r as TextStats;
      })
      .catch((e) => console.error("[text-stats] analyze 失败", e));
  }, 400);
});

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="text-stats-view">
    <header class="text-stats-head">
      <h1>文本统计</h1>
      <p class="view-sub">
        {{ api.context.vault ? `工作区: ${api.context.vault}` : "尚未选择工作区（本工具无需工作区）" }}
        · 统计逻辑在命令 analyze（UI 经 api.call 调用）
      </p>
    </header>
    <div class="text-stats-panel">
      <textarea
        class="text-stats-input"
        placeholder="在此粘贴或输入文本，统计结果实时更新…"
        v-model="text"
        spellcheck="false"
      />
      <div class="text-stats-result">
        <div class="stat-row">
          <span class="stat-label">字符数</span>
          <span class="stat-value">{{ stats?.chars ?? 0 }}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">词数</span>
          <span class="stat-value">{{ stats?.words ?? 0 }}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">行数</span>
          <span class="stat-value">{{ stats?.lines ?? 0 }}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">段落数</span>
          <span class="stat-value">{{ stats?.paragraphs ?? 0 }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
