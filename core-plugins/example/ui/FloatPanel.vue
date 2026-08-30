<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * core-example 桌面浮窗面板（教学点：manifest `float` 声明的精简界面）。
 * 与主界面共用同一套命令（example.list / example.add / example.toggle），
 * 只展示快速操作：添加 + 最近条目 + 完成计数。样式只引用宿主 tokens，
 * 适配 280px 宽的小窗口（紧凑布局）。
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
const busy = ref(false);
const error = ref<string | null>(null);

const doneCount = computed(() => items.value.filter((i) => i.done).length);

onMounted(() => {
  if (!props.api.context.vault) return;
  props.api
    .call("example.list")
    .then((v) => (items.value = v as ExampleItem[]))
    .catch((e) => (error.value = String(e)));
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
    text.value = t;
  } finally {
    busy.value = false;
  }
}

async function toggle(id: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    items.value = (await props.api.call("example.toggle", { id })) as ExampleItem[];
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

onBeforeUnmount(() => undefined);
</script>

<template>
  <div class="fx-wrap">
    <div class="fx-head">
      <span class="fx-title">示例 · 浮窗</span>
      <span v-if="items.length" class="fx-count">{{ doneCount }}/{{ items.length }} 完成</span>
    </div>

    <div v-if="error" class="fx-error" role="alert">
      <span>{{ error }}</span>
      <button class="fx-close" aria-label="关闭错误提示" @click="error = null">×</button>
    </div>

    <div class="fx-input-row">
      <input
        v-model="text"
        class="fx-input"
        :placeholder="props.api.context.vault ? '快速添加…' : '未选择工作区'"
        :disabled="!props.api.context.vault"
        spellcheck="false"
        @keydown.enter="add"
      />
      <button class="fx-add" :disabled="!text.trim() || busy" @click="add">添加</button>
    </div>

    <div v-if="!props.api.context.vault" class="fx-empty">请先在主窗口选择工作区</div>
    <div v-else-if="items.length === 0" class="fx-empty">还没有条目，上面输入添加</div>
    <ul v-else class="fx-list">
      <li v-for="it in items.slice(0, 8)" :key="it.id" class="fx-item" :class="{ done: it.done }">
        <button
          class="fx-check"
          :class="{ on: it.done }"
          :aria-label="it.done ? `标记未完成：${it.text}` : `标记完成：${it.text}`"
          @click="toggle(it.id)"
        >
          {{ it.done ? "✓" : "" }}
        </button>
        <span class="fx-text">{{ it.text }}</span>
      </li>
    </ul>
  </div>
</template>

<style>
/* 只引用宿主设计令牌；紧凑适配 280px 宽浮窗 */
.fx-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
}
.fx-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.fx-title {
  font-size: var(--text-sm);
  font-weight: 650;
  letter-spacing: -0.01em;
}
.fx-count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--fg-faint);
}
.fx-error {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 5px 8px;
  background: var(--pastel-red-bg);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--pastel-red-fg);
  word-break: break-word;
}
.fx-close {
  flex: none;
  border: none;
  background: none;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
.fx-input-row {
  display: flex;
  gap: var(--space-2);
}
.fx-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
  color: var(--fg);
  font-size: var(--text-sm);
}
.fx-input:focus {
  outline: none;
  border-color: var(--accent);
}
.fx-add {
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--on-accent);
  font-size: var(--text-sm);
  cursor: pointer;
}
.fx-add:disabled {
  opacity: 0.5;
  cursor: default;
}
.fx-add:focus-visible,
.fx-check:focus-visible,
.fx-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.fx-empty {
  padding: var(--space-5) 0;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.fx-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.fx-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}
.fx-item:hover {
  background: var(--bg-soft);
}
.fx-item.done .fx-text {
  text-decoration: line-through;
  color: var(--fg-faint);
}
.fx-check {
  width: 16px;
  height: 16px;
  flex: none;
  border: 1.5px solid var(--border-strong);
  border-radius: 4px;
  background: transparent;
  color: var(--on-accent);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.fx-check.on {
  background: var(--accent);
  border-color: var(--accent);
}
.fx-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
