<script setup lang="ts">
import { onMounted, ref } from "vue";
import { logsPath, logsTail, logsClear, logLevelSet } from "../core/api";
import { openInExplorer } from "../core/api";
import Icon from "./Icon.vue";

/**
 * 设置页「日志」卡片：级别选择（debug/info，持久化 app.json logLevel）、
 * 日志目录（显示 + 资源管理器打开）、应用内日志查看器（当天尾部，级别过滤、
 * 刷新、清空）。日志保留策略：自动保留最近 7 天（core/log.rs prune）。
 */
const level = ref<"debug" | "info" | "warn" | "error">("info");
const dir = ref<string | null>(null);
const tail = ref("");
const tailLevel = ref<"all" | "debug" | "info" | "warn" | "error">("all");
const loading = ref(false);
const msg = ref<{ text: string; err: boolean } | null>(null);

const LEVELS: { id: "debug" | "info" | "warn" | "error"; label: string }[] = [
  { id: "debug", label: "调试（最详细）" },
  { id: "info", label: "信息（默认）" },
  { id: "warn", label: "仅警告/错误" },
  { id: "error", label: "仅错误" },
];

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    tail.value = await logsTail(400);
  } catch (e) {
    tail.value = `读取日志失败: ${e}`;
  } finally {
    loading.value = false;
  }
}

function filteredLines(): string[] {
  const lines = tail.value.split("\n").filter(Boolean);
  if (tailLevel.value === "all") return lines.slice(-200);
  return lines.filter((l) => {
    const m = l.match(/\[(debug|info|warn|error)\]/);
    return m ? m[1] === tailLevel.value : true;
  });
}

async function changeLevel(v: "debug" | "info" | "warn" | "error"): Promise<void> {
  level.value = v;
  try {
    await logLevelSet(v);
    msg.value = { text: `日志级别已设为「${v}」（立即生效并持久化）`, err: false };
  } catch (e) {
    msg.value = { text: `设置失败: ${e}`, err: true };
  }
}

async function clearLogs(): Promise<void> {
  try {
    await logsClear();
    msg.value = { text: "日志已清空", err: false };
    await refresh();
  } catch (e) {
    msg.value = { text: `清空失败: ${e}`, err: true };
  }
}

onMounted(async () => {
  logsPath()
    .then((d) => (dir.value = d))
    .catch(() => undefined);
  try {
    const s = await import("../core/api").then((m) => m.appSettingsGet());
    if (s.logLevel === "debug" || s.logLevel === "warn" || s.logLevel === "error") {
      level.value = s.logLevel;
    }
  } catch {
    /* 忽略 */
  }
  await refresh();
});
</script>

<template>
  <section class="settings-card">
    <h2 class="settings-title">日志</h2>

    <div class="settings-row">
      <span class="settings-label">日志级别</span>
      <select
        class="settings-select"
        :value="level"
        @change="changeLevel(($event.target as HTMLSelectElement).value as typeof level)"
      >
        <option v-for="l in LEVELS" :key="l.id" :value="l.id">{{ l.label }}</option>
      </select>
      <span class="settings-hint">低于所选级别的日志不再记录（文件与终端都不写）；保留最近 7 天</span>
    </div>

    <div class="settings-row">
      <span class="settings-label">日志目录</span>
      <code class="settings-path" :title="dir ?? ''">{{ dir ?? "（未初始化）" }}</code>
      <button class="btn btn-sm" :disabled="!dir" @click="openInExplorer(dir!)">
        <Icon name="folder" :size="13" />
        打开目录
      </button>
    </div>

    <div class="settings-row">
      <span class="settings-label">查看日志</span>
      <div class="settings-actions">
        <select
          class="settings-select settings-select-sm"
          :value="tailLevel"
          @change="tailLevel = ($event.target as HTMLSelectElement).value as typeof tailLevel"
        >
          <option value="all">全部级别</option>
          <option value="debug">debug</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <button class="btn btn-sm" @click="refresh" :disabled="loading">
          {{ loading ? "读取中…" : "刷新" }}
        </button>
        <button class="btn btn-sm" @click="clearLogs">清空</button>
      </div>
    </div>

    <pre v-if="filteredLines().length" class="log-viewer">{{ filteredLines().join("\n") }}</pre>
    <p v-else class="settings-hint" style="margin-top: var(--space-2)">（当天暂无该级别日志）</p>

    <p
      v-if="msg"
      class="settings-message"
      :class="msg.err ? 'err' : 'ok'"
      style="margin-top: var(--space-2)"
    >
      {{ msg.text }}
    </p>
  </section>
</template>
