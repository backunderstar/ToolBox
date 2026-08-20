<script setup lang="ts">
import { computed } from "vue";
import { isCoreConnected, type PingInfo } from "../core/ipc";
import type { ThemeMode } from "../themes/themes";

/**
 * 状态栏（应用外壳）：IPC 连接状态 / 操作反馈 / 当前主题模式 /
 * 工作区名 / 核心版本。data-part="statusbar"（皮肤插件公开钩子）。
 */
const props = defineProps<{
  ping: PingInfo | null;
  theme: ThemeMode;
  vaultName: string | null;
  status: string;
}>();

const ok = computed(() => isCoreConnected(props.ping));
const label = computed(() => (props.ping ? props.ping.message : "连接中…"));
</script>

<template>
  <footer class="statusbar" data-part="statusbar">
    <span
      class="status-dot"
      :class="{ warn: !ok }"
      :title="ok ? 'IPC 链路正常' : '未连接 Tauri 核心（浏览器预览）'"
    />
    <span :title="label">{{ ok ? "核心已连接" : "核心未连接" }}</span>
    <span class="status-msg" :title="status">{{ status }}</span>
    <div class="spacer" />
    <span>主题 {{ theme === "light" ? "亮色" : "暗色" }}</span>
    <span class="status-path" :title="vaultName ?? undefined">
      工作区 {{ vaultName ?? "未选择" }}
    </span>
    <span>核心 v{{ ping?.coreVersion ?? "…" }}</span>
  </footer>
</template>
