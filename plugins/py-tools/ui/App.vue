<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * py-tools 自带前端——process（Python）插件界面的教学示例。
 * 教学点：① 界面经 api.call 调 Python 命令（JSON-RPC 桥）；② api.on 订阅
 * Python 进程推送的事件（progress）；③ 复用宿主全局 CSS class（.btn /
 * .plugin-error）+ 插件私有 style.css；④ 命令失败错误可见（不静默吞错）。
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
</script>

<template>
  <div class="py-tools-ui">
    <h2>Python 文本工具</h2>
    <p class="py-tools-sub">
      process（Python）插件自带前端示例：界面与 Python 子进程经 JSON-RPC 桥通信
      （api.call → plugin_call），下方三个卡片分别调用 pytext.stats /
      pytext.humanDate / pytext.eventDemo。
    </p>

    <section class="py-tools-card">
      <h3>文本统计（pytext.stats）</h3>
      <textarea v-model="text" rows="4" class="py-tools-textarea" />
      <div class="py-tools-actions">
        <button class="btn" @click="runStats">统计</button>
      </div>
      <pre v-if="stats" class="py-tools-result">{{ JSON.stringify(stats, null, 2) }}</pre>
    </section>

    <section class="py-tools-card">
      <h3>日期人性化（pytext.humanDate · dateutil vendored）</h3>
      <div class="py-tools-row">
        <input v-model="dateStr" class="py-tools-input" placeholder="任意格式日期" />
        <input
          v-model="dateFmt"
          class="py-tools-input"
          style="width: 190px"
          placeholder="输出格式（strftime）"
        />
        <button class="btn" @click="runDate">转换</button>
      </div>
      <p v-if="dateResult" class="py-tools-result">{{ dateResult }}</p>
    </section>

    <section class="py-tools-card">
      <h3>事件推送（pytext.eventDemo · api.on 订阅）</h3>
      <button class="btn" :disabled="running" @click="runEventDemo">
        {{ running ? "处理中…" : "发送进度事件" }}
      </button>
      <div v-if="progress" class="py-tools-progress">
        <span class="py-tools-progress-percent">{{ progress.percent }}%</span>
        <span>{{ progress.message }}</span>
      </div>
      <ul v-if="eventLog.length" class="py-tools-events">
        <li v-for="(e, i) in eventLog.slice(-6).reverse()" :key="i">{{ e }}</li>
      </ul>
    </section>

    <p v-if="error" class="plugin-error">{{ error }}</p>
  </div>
</template>

<style>
/* py-tools 自带前端私有样式：Vite 提取为 style.css 产物（宿主注入 <style>）。
   复用宿主全局 class（.btn / .plugin-error）与 CSS 变量为主，这里只写宿主没有的
   表单/布局细节；类名统一 py-tools-* 前缀避免污染宿主。 */
.py-tools-ui {
  max-width: 720px;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.py-tools-ui h2 {
  margin: 0;
  font-size: var(--text-xl);
  letter-spacing: -0.02em;
}
.py-tools-sub {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.7;
}
.py-tools-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  padding: var(--space-4);
}
.py-tools-card h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
}
.py-tools-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}
.py-tools-input {
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg);
  font-size: var(--text-sm);
  min-width: 200px;
}
.py-tools-actions,
.py-tools-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.py-tools-result {
  margin: var(--space-2) 0 0;
  padding: 8px 10px;
  background: var(--bg-soft);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--fg);
  white-space: pre-wrap;
}
.py-tools-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--fg-muted);
}
.py-tools-progress-percent {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--accent-strong);
}
.py-tools-events {
  margin: var(--space-2) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-faint);
}
</style>
