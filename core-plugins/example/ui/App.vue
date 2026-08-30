<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * core-example 插件自带前端（教学示例）——Vue 3。
 * 教学点：① 桥的 call（命令）/ on（事件订阅）/ context（宿主快照）/ host.search
 * （宿主搜索）；② 并发守卫（读-改-写异步命令，命令在途拒绝新命令防丢数据）；
 * ③ 错误可见反馈（不静默吞错）；④ 复用宿主设计令牌（tokens.css 变量）+ 全局
 * CSS class，样式写在 <style> 块（Vite 提取为 style.css 产物，构建/部署自动带上；
 * 不要写独立未 import 的 style.css——构建链路不会复制它）。
 */
interface ExampleItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

const props = defineProps<{ api: PluginBridgeApi }>();

const items = ref<ExampleItem[]>([]);
const text = ref("");
const ready = ref(false);
const error = ref<string | null>(null);
/** 命令在途守卫：连按/双击时后端读-改-写会并发，后写覆盖先写丢数据 */
const busy = ref(false);
/** example.info 回显（教学点：命令返回 + manifest 配置注入） */
const info = ref<{ plugin: string; vault: string; author: string } | null>(null);
/** 事件日志（教学点：api.on 订阅本插件广播的事件） */
const eventLog = ref<string[]>([]);
/** 宿主搜索演示结果（教学点：host.search 调用宿主聚合搜索） */
const searchResult = ref<string | null>(null);

const vaultMissing = computed(() => !props.api.context.vault);

/* 加载数据 + 订阅变更事件（任意窗口改动都刷新——多窗口一致） */
onMounted(() => {
  let alive = true;
  (async () => {
    try {
      if (!props.api.context.vault) {
        ready.value = true;
        return;
      }
      items.value = (await props.api.call("example.list")) as ExampleItem[];
      info.value = (await props.api.call("example.info")) as typeof info.value;
    } catch (e) {
      if (alive) error.value = String(e);
    } finally {
      if (alive) ready.value = true;
    }
  })();
  const un = props.api.on("example-changed", (data) => {
    eventLog.value = [...eventLog.value, `example-changed ${JSON.stringify(data)}`].slice(-5);
    if (!props.api.context.vault) return;
    props.api
      .call("example.list")
      .then((v) => (items.value = v as ExampleItem[]))
      .catch(() => undefined);
  });
  // 教学点：宿主外壳动作（顶栏按钮 / 托盘菜单项）经 plugin-event `action` 事件到达
  const unAction = props.api.on("action", (data) => {
    const d = (data ?? {}) as { action?: string; source?: string };
    eventLog.value = [...eventLog.value, `action ${d.source ?? "?"} → ${d.action ?? "?"}`].slice(-5);
  });
  onBeforeUnmount(() => {
    alive = false;
    un();
    unAction();
  });
});

async function add(): Promise<void> {
  const t = text.value.trim();
  if (!t || busy.value) return;
  busy.value = true;
  text.value = "";
  try {
    items.value = (await props.api.call("example.add", { text: t })) as ExampleItem[];
    error.value = null;
  } catch (e) {
    error.value = String(e);
    text.value = t; // 失败恢复输入，避免用户输入丢失
  } finally {
    busy.value = false;
  }
}

async function toggle(id: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    items.value = (await props.api.call("example.toggle", { id })) as ExampleItem[];
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function remove(id: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    items.value = (await props.api.call("example.delete", { id })) as ExampleItem[];
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

/** 教学点：调用宿主聚合搜索（FTS + 所有启用插件的 search.provide 命中） */
async function doSearch(): Promise<void> {
  if (!props.api.host?.search) return;
  try {
    const hits = (await props.api.host.search(text.value.trim() || "示例")) as {
      filename?: string;
      source?: string;
    }[];
    searchResult.value = hits.length
      ? hits
          .slice(0, 5)
          .map((h) => `${h.source ? `[${h.source}] ` : ""}${h.filename ?? "?"}`)
          .join("\n")
      : "（无命中）";
  } catch (e) {
    searchResult.value = `搜索失败: ${e}`;
  }
}

const doneCount = computed(() => items.value.filter((i) => i.done).length);

/** 时间戳 → HH:MM 短格式（轻量打磨：原始 ISO 串过长） */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
</script>

<template>
  <div class="ex-wrap">
    <!-- 头部：插件名 + 教学副标题 + 配置信息行（context.vault + example.info 回显） -->
    <header class="ex-header">
      <div>
        <h2 class="ex-title">示例插件 <span class="ex-badge">教学模板</span></h2>
        <p class="ex-sub">
          核心插件自带前端：命令 CRUD / 事件订阅 / 宿主搜索 / 外壳动作，全部实现要点
        </p>
      </div>
      <div v-if="info" class="ex-meta">
        <code class="ex-chip">{{ info.plugin }}</code>
        <span class="ex-chip">作者：{{ info.author }}</span>
        <span class="ex-chip ex-vault" :title="info.vault">工作区：{{ info.vault }}</span>
      </div>
    </header>

    <div v-if="error" class="ex-error" role="alert">
      <span>{{ error }}</span>
      <button class="ex-error-close" aria-label="关闭错误提示" @click="error = null">×</button>
    </div>

    <!-- 输入行 + 宿主搜索演示 -->
    <div class="ex-input-row">
      <input
        v-model="text"
        class="ex-input"
        @keydown.enter="add"
        :placeholder="vaultMissing ? '未选择工作区' : '添加示例条目，回车确认…'"
        :disabled="vaultMissing"
        spellcheck="false"
      />
      <button class="ex-btn ex-btn-primary" @click="add" :disabled="!text.trim() || vaultMissing">
        添加
      </button>
      <button
        class="ex-btn"
        title="教学点：调用宿主聚合搜索（FTS + 搜索提供者）"
        @click="doSearch"
        :disabled="vaultMissing"
      >
        搜索
      </button>
    </div>

    <section v-if="searchResult" class="ex-panel" aria-label="搜索演示结果">
      <div class="ex-panel-head">
        <span>宿主搜索（FTS + 提供者聚合）</span>
        <button class="ex-clear" aria-label="关闭搜索结果" @click="searchResult = null">×</button>
      </div>
      <pre class="ex-search">{{ searchResult }}</pre>
    </section>

    <section class="ex-panel ex-list-panel" aria-label="示例条目">
      <div class="ex-list" aria-live="polite">
        <div v-if="!ready" class="ex-empty">加载中…</div>
        <div v-else-if="vaultMissing" class="ex-empty">
          请先在主窗口选择一个工作区，再使用示例列表
        </div>
        <div v-else-if="items.length === 0" class="ex-empty">
          <p class="ex-empty-title">还没有条目</p>
          <p class="ex-empty-sub">在顶部输入内容，回车或点「添加」创建第一条</p>
        </div>
        <div v-for="it in items" :key="it.id" class="ex-item" :class="{ done: it.done }">
          <button
            class="ex-check"
            :class="{ on: it.done }"
            :title="it.done ? '标记未完成' : '标记完成'"
            :aria-label="it.done ? `标记未完成：${it.text}` : `标记完成：${it.text}`"
            @click="toggle(it.id)"
          >
            <svg v-if="it.done" viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <span class="ex-item-text">{{ it.text }}</span>
          <span class="ex-item-time" :title="it.createdAt">{{ fmtTime(it.createdAt) }}</span>
          <button
            class="ex-del"
            title="删除"
            :aria-label="`删除条目：${it.text}`"
            @click="remove(it.id)"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
              <path d="M3 5h10M6.5 5V3.5h3V5M5 5l.6 7h4.8l.6-7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      <div v-if="items.length > 0" class="ex-foot">
        <span>共 {{ items.length }} 条 · 完成 {{ doneCount }}</span>
        <span class="ex-foot-hint">勾选 / 删除走 JSON-RPC 命令（vault 文件真源）</span>
      </div>
    </section>

    <!-- 教学点：事件日志（api.on 收到本插件 example-changed / 外壳 action） -->
    <section v-if="eventLog.length > 0" class="ex-panel" aria-label="事件日志">
      <div class="ex-panel-head">
        <span>事件日志（api.on 订阅）</span>
        <button class="ex-clear" aria-label="清空事件日志" @click="eventLog = []">×</button>
      </div>
      <div class="ex-events">
        <div v-for="(e, i) in eventLog" :key="i" class="ex-event">{{ e }}</div>
      </div>
    </section>
  </div>
</template>

<style>
/* core-example 插件私有样式：Vite 提取为 style.css 产物（宿主注入 <style>）。
   只引用宿主设计令牌（tokens.css 变量）与全局 class，随亮暗主题自适应；
   类名统一 ex-* 前缀避免污染宿主。 */
.ex-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  overflow-y: auto;
}

/* ---- 头部 ---- */
.ex-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.ex-title {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.ex-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.ex-sub {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  line-height: 1.6;
}
.ex-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: 2px;
}
.ex-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
  color: var(--fg-muted);
  font-size: 11px;
  font-family: var(--font-mono);
}
.ex-vault {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 错误条 ---- */
.ex-error {
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
.ex-error-close {
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
.ex-error-close:hover {
  background: rgba(0, 0, 0, 0.08);
}

/* ---- 输入行 ---- */
.ex-input-row {
  display: flex;
  gap: var(--space-2);
}
.ex-input {
  flex: 1;
  min-width: 0;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg);
  font-size: var(--text-md);
  transition:
    border-color var(--dur) var(--ease),
    background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.ex-input::placeholder {
  color: var(--fg-faint);
}
.ex-input:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.ex-input:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--bg-elevated);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.ex-input:disabled {
  opacity: 0.55;
  cursor: default;
}

/* ---- 按钮（主/次两级，复用宿主 tokens） ---- */
.ex-btn {
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
.ex-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--border-strong);
  background: var(--bg-elevated);
}
.ex-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.ex-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ex-btn:focus-visible,
.ex-check:focus-visible,
.ex-del:focus-visible,
.ex-clear:focus-visible,
.ex-error-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ex-btn-primary {
  background: var(--accent);
  border-color: transparent;
  color: var(--on-accent);
}
.ex-btn-primary:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: transparent;
  color: var(--on-accent);
}

/* ---- 面板（列表 / 搜索 / 事件日志共用） ---- */
.ex-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.ex-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 8px var(--space-4);
  border-bottom: 1px solid var(--border);
  font-size: var(--text-xs);
  color: var(--fg-muted);
  letter-spacing: 0.02em;
}
.ex-clear {
  border: none;
  background: none;
  color: var(--fg-faint);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.ex-clear:hover {
  color: var(--fg);
  background: var(--bg-soft);
}

/* ---- 搜索演示 ---- */
.ex-search {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  color: var(--fg-muted);
  background: var(--bg-soft);
}

/* ---- 列表 ---- */
.ex-list-panel {
  flex: 1;
  min-height: 0;
}
.ex-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2);
}
.ex-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: var(--space-8) 0;
  text-align: center;
}
.ex-empty-title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--fg-muted);
}
.ex-empty-sub {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-faint);
}
.ex-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 8px;
  border-radius: var(--radius-md);
  font-size: var(--text-md);
  transition: background var(--dur) var(--ease);
}
.ex-item:hover {
  background: var(--bg-soft);
}
.ex-item.done .ex-item-text {
  text-decoration: line-through;
  color: var(--fg-faint);
}
.ex-check {
  width: 18px;
  height: 18px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--border-strong);
  border-radius: 5px;
  background: transparent;
  color: var(--on-accent);
  cursor: pointer;
  padding: 0;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
.ex-check:hover:not(.on) {
  border-color: var(--accent);
}
.ex-check.on {
  background: var(--accent);
  border-color: var(--accent);
}
.ex-check:active {
  transform: scale(0.92);
}
.ex-item-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ex-item-time {
  flex: none;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  color: var(--fg-faint);
}
.ex-del {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--fg-faint);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--dur) var(--ease),
    color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.ex-item:hover .ex-del,
.ex-del:focus-visible {
  opacity: 1;
}
.ex-del:hover {
  color: var(--danger);
  background: var(--pastel-red-bg);
}
.ex-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 8px var(--space-4);
  border-top: 1px solid var(--border);
  font-size: var(--text-xs);
  color: var(--fg-muted);
}
.ex-foot-hint {
  color: var(--fg-faint);
}

/* ---- 事件日志 ---- */
.ex-events {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-4) var(--space-3);
  max-height: 160px;
  overflow-y: auto;
}
.ex-event {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.7;
  color: var(--fg-muted);
}
</style>
