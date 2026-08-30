<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/** 模板界面：一个调用 Python 命令的按钮 + 事件订阅演示。
 *  样式写在 <style> 块（构建时 Vite 提取为 ui/style.css，宿主注入）；
 *  只引用宿主设计令牌（tokens.css 变量），随亮暗主题自适应。 */
const props = defineProps<{ api: PluginBridgeApi }>();

const greeting = ref<string | null>(null);
const events = ref<string[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

async function sayHello(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    const r = (await props.api.call("hello")) as { message: string };
    greeting.value = r.message;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function sendEvents(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    await props.api.call("eventDemo");
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

/* 订阅 Python 进程推送的 progress 事件 */
const off = props.api.on("progress", (data) => {
  const d = data as { percent: number; message: string };
  events.value = [...events.value, `progress ${d.percent}%: ${d.message}`].slice(-8);
});
onBeforeUnmount(off);
</script>

<template>
  <div class="tpl-ui">
    <header class="tpl-header">
      <h2 class="tpl-title">我的插件</h2>
      <p class="tpl-sub">外部插件模板：界面与 Python 子进程经 JSON-RPC 桥通信</p>
    </header>

    <div v-if="error" class="tpl-error" role="alert">
      <span>{{ error }}</span>
      <button class="tpl-error-close" aria-label="关闭错误提示" @click="error = null">×</button>
    </div>

    <section class="tpl-card">
      <div class="tpl-card-head">
        <h3>命令调用</h3>
        <code class="tpl-cmd">api.call("hello")</code>
      </div>
      <div class="tpl-actions">
        <button class="tpl-btn tpl-btn-primary" :disabled="busy" @click="sayHello">打招呼</button>
        <button class="tpl-btn" :disabled="busy" @click="sendEvents">发送事件</button>
      </div>
      <p v-if="greeting" class="tpl-result">{{ greeting }}</p>
    </section>

    <section v-if="events.length" class="tpl-card">
      <div class="tpl-card-head">
        <h3>事件流</h3>
        <code class="tpl-cmd">api.on("progress")</code>
      </div>
      <ul class="tpl-events">
        <li v-for="(e, i) in events.slice(-4).reverse()" :key="i" class="tpl-event">{{ e }}</li>
      </ul>
    </section>
  </div>
</template>

<style>
/* 只引用宿主设计令牌（tokens.css 变量，如 --bg、--fg、--accent、--space-*、--radius-*）；
   类名统一 tpl-* 前缀避免污染宿主。 */
.tpl-ui {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  box-sizing: border-box;
  overflow-y: auto;
}
.tpl-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.tpl-title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.tpl-sub {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  line-height: 1.6;
}
.tpl-error {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 12px;
  background: var(--pastel-red-bg);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--pastel-red-fg);
  word-break: break-word;
}
.tpl-error-close {
  flex: none;
  border: none;
  background: none;
  color: inherit;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.tpl-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-1);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.tpl-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.tpl-card-head h3 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 650;
}
.tpl-cmd {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-faint);
}
.tpl-actions {
  display: flex;
  gap: var(--space-2);
}
.tpl-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    color var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.tpl-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--border-strong);
  background: var(--bg-elevated);
}
.tpl-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.tpl-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.tpl-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tpl-btn-primary {
  background: var(--accent);
  border-color: transparent;
  color: var(--on-accent);
}
.tpl-btn-primary:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: transparent;
  color: var(--on-accent);
}
.tpl-result {
  margin: 0;
  padding: 8px 12px;
  background: var(--bg-soft);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--fg);
}
.tpl-events {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  list-style: none;
  background: var(--bg-soft);
  border-radius: var(--radius-md);
}
.tpl-event {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.7;
  color: var(--fg-muted);
}
</style>
