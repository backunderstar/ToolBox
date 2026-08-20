<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { PluginBridgeApi } from "./bridge";

/** 反链面板（数据来自跨插件索引；点击跳转清单） */
const props = defineProps<{
  activePath: string;
  backlinks: Map<string, { type: "清单"; id: string; title: string }[]>;
  nav?: PluginBridgeApi["nav"];
}>();

const open = ref(false);
watch(
  () => props.activePath,
  () => (open.value = false),
);

const matches = computed(() => {
  const base = props.activePath.replace(/^\/+/, "");
  const baseName = props.activePath.split("/").pop() ?? props.activePath;
  const out: { type: "清单"; title: string; id: string }[] = [];
  let exact = 0;
  for (const [path, entries] of props.backlinks) {
    if (path === base) {
      for (const e of entries) out.push({ type: e.type, title: e.title, id: e.id });
      exact += entries.length;
    }
  }
  if (exact === 0) {
    for (const [path, entries] of props.backlinks) {
      if (path.split("/").pop() === baseName) {
        for (const e of entries) out.push({ type: e.type, title: e.title, id: e.id });
      }
    }
  }
  return out;
});
</script>

<template>
  <div v-if="matches.length > 0" class="backlinks">
    <button class="backlinks-toggle" @click="open = !open">
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M9.5 14.5l5-5" />
        <path d="M8 12.5L5.5 15a3.5 3.5 0 0 0 5 5L13 17.5" />
        <path d="M16 11.5l2.5-2.5a3.5 3.5 0 0 0-5-5L11 6.5" />
      </svg>
      <span>反向链接 {{ matches.length }}</span>
      <svg
        class="backlinks-caret"
        :class="{ flip: open }"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
    <div v-if="open" class="backlinks-list">
      <button
        v-for="(m, i) in matches"
        :key="`${m.type}-${m.id}-${i}`"
        class="backlink-item"
        @click="nav?.openChecklist(m.id)"
      >
        <span class="backlink-type backlink-type-check">{{ m.type }}</span>
        <span class="backlink-title">{{ m.title }}</span>
      </button>
    </div>
  </div>
</template>
