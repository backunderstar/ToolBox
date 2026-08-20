<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * core-todos 插件自带前端（浮窗快速待办）——Vue 3。
 * 宿主 FloatApp 提供统一外壳（标题栏/位置锁定/页签），本组件只渲染内容：
 * 输入行、待办列表、清除已完成（复用宿主全局 .float-* class）。
 */
interface TodosItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

const props = defineProps<{ api: PluginBridgeApi }>();

const items = ref<TodosItem[]>([]);
const text = ref("");
const ready = ref(false);
const error = ref<string | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
// 并发守卫：读-改-写命令是异步的，连按/双击会并发调用；后端无串行化时
// 后写覆盖先写会丢条目。命令在途时拒绝新命令（同 ai 插件的 busyRef 模式）。
const busy = ref(false);

const vaultMissing = computed(() => !props.api.context.vault);

/* 加载数据 + 订阅变更事件（主窗口/浮窗任意改动都刷新） */
onMounted(() => {
  let alive = true;
  (async () => {
    try {
      if (!props.api.context.vault) {
        ready.value = true;
        return;
      }
      if (!alive) return;
      items.value = (await props.api.call("todos.list")) as TodosItem[];
    } catch (e) {
      if (alive) error.value = String(e);
    } finally {
      if (alive) ready.value = true;
    }
  })();
  const un = props.api.on("todos-changed", () => {
    if (!props.api.context.vault) return;
    props.api
      .call("todos.list")
      .then((v) => (items.value = v as TodosItem[]))
      .catch(() => undefined);
  });
  onBeforeUnmount(() => {
    alive = false;
    un();
  });
});

async function add(): Promise<void> {
  const t = text.value.trim();
  if (!t || busy.value) return;
  busy.value = true;
  text.value = "";
  try {
    items.value = (await props.api.call("todos.add", { text: t })) as TodosItem[];
    error.value = null;
  } catch (e) {
    error.value = String(e);
    text.value = t; // 失败恢复输入，避免用户输入丢失
  } finally {
    busy.value = false;
    inputRef.value?.focus();
  }
}

async function toggle(id: string): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    items.value = (await props.api.call("todos.toggle", { id })) as TodosItem[];
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
    items.value = (await props.api.call("todos.delete", { id })) as TodosItem[];
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function clearDone(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    items.value = (await props.api.call("todos.clearDone")) as TodosItem[];
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

const doneCount = computed(() => items.value.filter((i) => i.done).length);
</script>

<template>
  <div style="display: flex; flex-direction: column; flex: 1; min-height: 0">
    <!-- 输入行 -->
    <div class="float-input-row">
      <input
        ref="inputRef"
        class="float-input"
        v-model="text"
        @keydown.enter="add"
        :placeholder="vaultMissing ? '未选择工作区' : '添加待办，回车确认…'"
        :disabled="vaultMissing"
        spellcheck="false"
      />
      <button
        class="float-add"
        @click="add"
        :disabled="!text.trim() || vaultMissing"
        title="添加"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>

    <!-- 错误提示条：可见反馈，替代静默吞错 -->
    <div v-if="error" class="float-error" role="alert">
      <span>{{ error }}</span>
      <button @click="error = null" aria-label="关闭错误提示">×</button>
    </div>

    <!-- 待办列表 -->
    <div class="float-list" aria-live="polite">
      <div v-if="!ready" class="float-empty">加载中…</div>
      <div v-else-if="vaultMissing" class="float-empty">请先在主窗口选择一个工作区</div>
      <div v-else-if="items.length === 0" class="float-empty">暂无待办 —— 上面输入即可添加</div>
      <div
        v-for="it in items"
        :key="it.id"
        class="float-item"
        :class="{ done: it.done }"
      >
        <button
          class="float-check"
          :class="{ on: it.done }"
          :title="it.done ? '标记未完成' : '标记完成'"
          :aria-label="it.done ? `标记未完成：${it.text}` : `标记完成：${it.text}`"
          @click="toggle(it.id)"
        >
          <svg
            v-if="it.done"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 12.5l5 5L20 6.5" />
          </svg>
        </button>
        <span class="float-item-text">{{ it.text }}</span>
        <button
          class="float-del"
          title="删除"
          :aria-label="`删除待办：${it.text}`"
          @click="remove(it.id)"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 底部：清除已完成 -->
    <div v-if="items.length > 0" class="float-foot">
      <button class="float-clear" @click="clearDone" :disabled="doneCount === 0">
        清除已完成（{{ doneCount }}）
      </button>
    </div>
  </div>
</template>
