<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * py-tools 自带前端——process（Python）插件界面的教学示例。
 * 教学点：① 界面经 api.call 调 Python 命令（JSON-RPC 桥）；② api.on 订阅
 * Python 进程推送的事件（progress）；③ 复用宿主设计令牌 + 全局 class；
 * ④ 命令失败错误可见（不静默吞错）。样式写在 <style> 块（Vite 提取为
 * style.css 产物，构建/部署自动带上）。
 */
const props = defineProps<{ api: PluginBridgeApi }>();

const text = ref("Hello ToolBox！你好，工具箱。\n第二行。");
const stats = ref<Record<string, number> | null>(null);
const dateStr = ref("2026-08-29 18:30");
const dateFmt = ref("%Y-%m-%d %H:%M");
const dateResult = ref<string | null>(null);
const progress = ref<{ percent: number; message: string } | null>(null);
const eventLog = ref<string[]>([]);
const error = ref<string | null>(null);
const running = ref(false);

async function runStats(): Promise<void> {
  error.value = null;
  try {
    const r = (await props.api.call("pytext.stats", { text: text.value })) as Record<string, number>;
    stats.value = r;
  } catch (e) {
    error.value = String(e);
  }
}

async function runDate(): Promise<void> {
  error.value = null;
  try {
    const r = (await props.api.call("pytext.humanDate", {
      date: dateStr.value,
      fmt: dateFmt.value,
    })) as { parsed: string; formatted: string };
    dateResult.value = `${r.formatted}（dateutil 解析：${r.parsed}）`;
  } catch (e) {
    error.value = String(e);
  }
}

async function runEventDemo(): Promise<void> {
  error.value = null;
  running.value = true;
  progress.value = null;
  try {
    const r = (await props.api.call("pytext.eventDemo", { percent: 100 })) as { text: string };
    eventLog.value = [...eventLog.value, r.text].slice(-20);
  } catch (e) {
    error.value = String(e);
  } finally {
    running.value = false;
  }
}

/* 订阅 Python 进程推送的 progress 事件（插件 call 期间宿主转发为 plugin-event） */
const offProgress = props.api.on("progress", (data) => {
  const d = data as { percent: number; message: string };
  progress.value = d;
  eventLog.value = [...eventLog.value, `progress ${d.percent}%: ${d.message}`].slice(-20);
});
onBeforeUnmount(offProgress);

/** 统计结果行：键 → 中文标签 + 数值对齐展示 */
const STAT_LABELS: [string, string][] = [
  ["chars", "字符"],
  ["words", "单词"],
  ["lines", "行数"],
  ["nonEmptyLines", "非空行"],
  ["paragraphs", "段落"],
];
</script>

<template>
  <div class="py-tools-ui">
    <!-- 头部：插件名 + 说明 -->
    <header class="py-header">
      <h2 class="py-title">Python 文本工具</h2>
      <p class="py-sub">
        process（Python）插件自带前端示例：界面经 api.call 调 Python 命令（JSON-RPC
        over stdio），api.on 实时收进程推送的事件——前端与后端完全解耦。
      </p>
    </header>

    <div v-if="error" class="py-error" role="alert">
      <span>{{ error }}</span>
      <button class="py-error-close" aria-label="关闭错误提示" @click="error = null">×</button>
    </div>

    <!-- 文本统计 -->
    <section class="py-card">
      <div class="py-card-head">
        <h3>文本统计</h3>
        <code class="py-cmd">pytext.stats</code>
      </div>
      <textarea v-model="text" rows="4" class="py-textarea" spellcheck="false" />
      <div class="py-actions">
        <button class="py-btn py-btn-primary" @click="runStats">统计</button>
      </div>
      <div v-if="stats" class="py-result">
        <div v-for="[key, label] in STAT_LABELS" :key="key" class="py-stat-row">
          <span class="py-stat-label">{{ label }}</span>
          <span class="py-stat-value">{{ stats[key] ?? 0 }}</span>
        </div>
      </div>
    </section>

    <!-- 日期人性化（dateutil vendored） -->
    <section class="py-card">
      <div class="py-card-head">
        <h3>日期人性化</h3>
        <code class="py-cmd">pytext.humanDate · dateutil</code>
      </div>
      <div class="py-row">
        <input v-model="dateStr" class="py-input" placeholder="任意格式日期，如 2026-08-29 18:30" />
        <input
          v-model="dateFmt"
          class="py-input py-input-fmt"
          placeholder="strftime 输出格式"
          title="strftime 格式，如 %Y-%m-%d %H:%M"
        />
        <button class="py-btn py-btn-primary" @click="runDate">转换</button>
      </div>
      <p v-if="dateResult" class="py-inline-result">{{ dateResult }}</p>
    </section>

    <!-- 事件推送 demo -->
    <section class="py-card">
      <div class="py-card-head">
        <h3>事件推送</h3>
        <code class="py-cmd">pytext.eventDemo · api.on("progress")</code>
      </div>
      <button class="py-btn" :disabled="running" @click="runEventDemo">
        {{ running ? "处理中…" : "发送进度事件" }}
      </button>
      <div v-if="progress" class="py-progress" role="status">
        <div class="py-progress-bar" :style="{ width: `${progress.percent}%` }" />
        <span class="py-progress-percent">{{ progress.percent }}%</span>
        <span class="py-progress-msg">{{ progress.message }}</span>
      </div>
      <TransitionGroup
        v-if="eventLog.length"
        tag="ul"
        name="py-list"
        class="py-events"
        aria-label="事件流"
      >
        <li v-for="(e, i) in eventLog.slice(-6).reverse()" :key="i" class="py-event">{{ e }}</li>
      </TransitionGroup>
    </section>
  </div>
</template>

<style>
/* py-tools 自带前端私有样式：Vite 提取为 style.css 产物（宿主注入 <style>）。
   只引用宿主设计令牌（tokens.css 变量），随亮暗主题自适应；类名统一 py-* 前缀。 */
.py-tools-ui {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  box-sizing: border-box;
  overflow-y: auto;
}

/* ---- 头部 ---- */
.py-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
}
.py-title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.py-sub {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  line-height: 1.6;
}

/* ---- 错误条（与 core-example 同语言） ---- */
.py-error {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 12px;
  background: var(--pastel-red-bg);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  line-height: 1.5;
  color: var(--pastel-red-fg);
  word-break: break-word;
}
.py-error-close {
  flex: none;
  border: none;
  background: none;
  color: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.py-error-close:hover {
  background: rgba(0, 0, 0, 0.08);
}

/* ---- 卡片 ---- */
.py-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-1);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.py-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.py-card-head h3 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 650;
  letter-spacing: -0.01em;
}
.py-cmd {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-faint);
}

/* ---- 输入 ---- */
.py-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.py-textarea:hover,
.py-input:hover {
  border-color: var(--border-strong);
}
.py-textarea:focus,
.py-input:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--bg-elevated);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.py-input {
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg);
  font-size: var(--text-sm);
  min-width: 0;
  flex: 1;
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.py-input-fmt {
  flex: 0 1 220px;
}
.py-input::placeholder,
.py-textarea::placeholder {
  color: var(--fg-faint);
}

/* ---- 按钮 ---- */
.py-actions,
.py-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.py-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.py-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--border-strong);
  background: var(--bg-elevated);
}
.py-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.py-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.py-btn:focus-visible,
.py-error-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.py-btn-primary {
  background: var(--accent);
  border-color: transparent;
  color: var(--on-accent);
}
.py-btn-primary:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: transparent;
  color: var(--on-accent);
}

/* ---- 结果展示 ---- */
.py-result {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--bg-soft);
  border-radius: var(--radius-md);
}
.py-stat-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.py-stat-label {
  font-size: var(--text-xs);
  color: var(--fg-muted);
}
.py-stat-value {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-lg);
  font-weight: 650;
  color: var(--fg);
}
.py-inline-result {
  margin: 0;
  padding: 8px 12px;
  background: var(--bg-soft);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--fg);
  word-break: break-word;
}

/* ---- 进度与事件流 ---- */
.py-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
.py-progress-percent {
  flex: none;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--accent-strong);
}
.py-progress-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.py-events {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 140px;
  overflow-y: auto;
  background: var(--bg-soft);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
}
.py-event {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.7;
  color: var(--fg-muted);
}
/* 事件流条目过渡（TransitionGroup）：淡入 + 位移 */
.py-list-enter-active,
.py-list-leave-active {
  transition:
    opacity 180ms var(--ease),
    transform 180ms var(--ease);
}
.py-list-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.py-list-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
