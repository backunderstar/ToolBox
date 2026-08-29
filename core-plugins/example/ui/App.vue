<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * core-example 插件自带前端（教学示例）——Vue 3。
 * 教学点：① 桥的 call（命令）/ on（事件订阅）/ context（宿主快照）/ host.search
 * （宿主搜索）；② 并发守卫（读-改-写异步命令，命令在途拒绝新命令防丢数据）；
 * ③ 错误可见反馈（不静默吞错）；④ 复用宿主全局 CSS class + 插件私有 style.css。
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
</script>

<template>
  <div class="ex-wrap">
    <!-- 教学点：context.vault 宿主快照 + example.info 配置回显 -->
    <div v-if="info" class="ex-info">
      <code>{{ info.plugin }}</code>
      <span>作者：{{ info.author }}</span>
      <span class="ex-vault" :title="info.vault">工作区：{{ info.vault }}</span>
    </div>

    <div v-if="error" class="ex-error" role="alert">
      <span>{{ error }}</span>
      <button @click="error = null" aria-label="关闭错误提示">×</button>
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
      <button class="ex-add" @click="add" :disabled="!text.trim() || vaultMissing">添加</button>
      <button
        class="ex-add"
        title="教学点：调用宿主聚合搜索（FTS + 搜索提供者）"
        @click="doSearch"
        :disabled="vaultMissing"
      >
        搜索
      </button>
    </div>
    <pre v-if="searchResult" class="ex-search">{{ searchResult }}</pre>

    <div class="ex-list" aria-live="polite">
      <div v-if="!ready" class="ex-empty">加载中…</div>
      <div v-else-if="vaultMissing" class="ex-empty">请先在主窗口选择一个工作区</div>
      <div v-else-if="items.length === 0" class="ex-empty">暂无条目 —— 上面输入即可添加</div>
      <div v-for="it in items" :key="it.id" class="ex-item" :class="{ done: it.done }">
        <button
          class="ex-check"
          :class="{ on: it.done }"
          :title="it.done ? '标记未完成' : '标记完成'"
          :aria-label="it.done ? `标记未完成：${it.text}` : `标记完成：${it.text}`"
          @click="toggle(it.id)"
        >
          {{ it.done ? "✓" : "" }}
        </button>
        <span class="ex-item-text">{{ it.text }}</span>
        <span class="ex-item-time" :title="it.createdAt">{{ it.createdAt }}</span>
        <button
          class="ex-del"
          title="删除"
          :aria-label="`删除条目：${it.text}`"
          @click="remove(it.id)"
        >
          ×
        </button>
      </div>
    </div>

    <div v-if="items.length > 0" class="ex-foot">
      <span>共 {{ items.length }} 条，完成 {{ doneCount }}</span>
    </div>

    <!-- 教学点：事件日志（api.on 收到本插件 example-changed） -->
    <div v-if="eventLog.length > 0" class="ex-events">
      <div v-for="(e, i) in eventLog" :key="i" class="ex-event">{{ e }}</div>
    </div>
  </div>
</template>
