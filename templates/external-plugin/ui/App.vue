<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * 模板界面：演示插件 UI 的全部常用交互——
 * ① api.call 调 Python 命令（hello / eventDemo / fileList / notifyDemo）
 * ② api.on 订阅 Python 进程推送的事件（progress）
 * ③ api.context.vault 读当前工作区
 * ④ host.search 调宿主聚合搜索（FTS + 搜索提供者）
 * 样式写在 <style> 块（构建时 Vite 提取为 ui/style.css，宿主注入）；
 * 只引用宿主设计令牌（tokens.css 变量，见 DEVELOPER.md §6），随亮暗主题自适应。
 */
const props = defineProps<{ api: PluginBridgeApi }>();

const greeting = ref<string | null>(null);
const events = ref<string[]>([]);
const error = ref<string | null>(null);
const busy = ref(false);

/* 工作区文件列表（经 Python 命令 fileList → 核心 API fs.listDir） */
const files = ref<string[]>([]);
const fileCount = ref(0);
const filesBusy = ref(false);

/* 宿主搜索（host.search 前端直接调用，不经 Python） */
const searchQuery = ref("");
const searchResult = ref<string | null>(null);
const searchBusy = ref(false);

async function sayHello(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    const r = (await props.api.call("hello", { name: "世界" })) as { message: string };
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

async function listFiles(): Promise<void> {
  error.value = null;
  filesBusy.value = true;
  try {
    const r = (await props.api.call("fileList")) as { count: number; files: string[] };
    files.value = r.files;
    fileCount.value = r.count;
  } catch (e) {
    error.value = String(e);
  } finally {
    filesBusy.value = false;
  }
}

async function sendNotify(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    await props.api.call("notifyDemo");
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function doSearch(): Promise<void> {
  error.value = null;
  if (!props.api.host?.search) return;
  searchBusy.value = true;
  try {
    const hits = (await props.api.host.search(searchQuery.value.trim() || "示例")) as {
      filename?: string;
      source?: string;
      snippet?: string;
    }[];
    searchResult.value = hits.length
      ? hits
          .slice(0, 5)
          .map((h) => `${h.source ? `[${h.source}] ` : ""}${h.filename ?? "?"}\n  ${h.snippet ?? ""}`)
          .join("\n")
      : "（无命中）";
  } catch (e) {
    searchResult.value = `搜索失败: ${e}`;
  } finally {
    searchBusy.value = false;
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
      <p class="tpl-sub">
        外部插件模板：界面与 Python 子进程经 JSON-RPC 桥通信；工作区：
        <code class="tpl-vault">{{ props.api.context.vault ?? "（未选择）" }}</code>
      </p>
    </header>

    <div v-if="error" class="tpl-error" role="alert">
      <span>{{ error }}</span>
      <button class="tpl-error-close" aria-label="关闭错误提示" @click="error = null">×</button>
    </div>

    <!-- 命令调用（api.call → Python JSON-RPC） -->
    <section class="tpl-card">
      <div class="tpl-card-head">
        <h3>命令调用</h3>
        <code class="tpl-cmd">api.call("hello" / "eventDemo" / "notifyDemo")</code>
      </div>
      <div class="tpl-actions">
        <button class="tpl-btn tpl-btn-primary" :disabled="busy" @click="sayHello">打招呼</button>
        <button class="tpl-btn" :disabled="busy" @click="sendEvents">发送事件</button>
        <button class="tpl-btn" :disabled="busy" @click="sendNotify">发通知横幅</button>
      </div>
      <p v-if="greeting" class="tpl-result">{{ greeting }}</p>
    </section>

    <!-- 工作区文件（核心 API fs.listDir，经 Python 命令） -->
    <section class="tpl-card">
      <div class="tpl-card-head">
        <h3>工作区文件</h3>
        <code class="tpl-cmd">api.call("fileList") → fs.listDir</code>
      </div>
      <button class="tpl-btn" :disabled="filesBusy" @click="listFiles">
        {{ filesBusy ? "列文件中…" : "列出 vault 内 Markdown" }}
      </button>
      <p v-if="fileCount > 0" class="tpl-meta">共 {{ fileCount }} 个 .md（显示前 {{ files.length }} 个）</p>
      <ul v-if="files.length" class="tpl-files">
        <li v-for="f in files" :key="f" class="tpl-file">{{ f }}</li>
      </ul>
    </section>

    <!-- 宿主搜索（host.search 前端直接调用，不经过 Python） -->
    <section class="tpl-card">
      <div class="tpl-card-head">
        <h3>宿主搜索</h3>
        <code class="tpl-cmd">api.host.search(query)</code>
      </div>
      <div class="tpl-actions">
        <input
          v-model="searchQuery"
          class="tpl-input"
          placeholder="全文搜索（FTS + 插件提供者）"
          @keydown.enter="doSearch"
        />
        <button class="tpl-btn" :disabled="searchBusy" @click="doSearch">
          {{ searchBusy ? "搜索中…" : "搜索" }}
        </button>
      </div>
      <pre v-if="searchResult" class="tpl-result">{{ searchResult }}</pre>
    </section>

    <!-- 事件流（api.on 订阅 Python 进程推送的事件） -->
    <section v-if="events.length" class="tpl-card">
      <div class="tpl-card-head">
        <h3>事件流</h3>
        <code class="tpl-cmd">api.on("progress")</code>
      </div>
      <TransitionGroup tag="ul" name="tpl-list" class="tpl-events">
        <li v-for="(e, i) in events.slice(-4).reverse()" :key="i" class="tpl-event">{{ e }}</li>
      </TransitionGroup>
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
.tpl-vault {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent-strong);
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
  align-items: center;
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
.tpl-btn:focus-visible,
.tpl-input:focus-visible {
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
.tpl-input {
  flex: 1;
  min-width: 0;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg);
  font-size: var(--text-sm);
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.tpl-input::placeholder {
  color: var(--fg-faint);
}
.tpl-input:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--bg-elevated);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.tpl-result {
  margin: 0;
  padding: 8px 12px;
  background: var(--bg-soft);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--fg);
  white-space: pre-wrap;
}
.tpl-meta {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--fg-muted);
}
.tpl-files {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  list-style: none;
  background: var(--bg-soft);
  border-radius: var(--radius-md);
  max-height: 160px;
  overflow-y: auto;
}
.tpl-file {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.8;
  color: var(--fg-muted);
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
/* 事件流条目过渡（TransitionGroup）：淡入 + 位移 */
.tpl-list-enter-active,
.tpl-list-leave-active {
  transition:
    opacity 180ms var(--ease),
    transform 180ms var(--ease);
}
.tpl-list-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.tpl-list-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
