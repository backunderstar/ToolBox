<script setup lang="ts">
import { computed } from "vue";
import type { SearchHit } from "./bridge";

/** 搜索结果（迁移自宿主 NotesView.SearchResults；关键词高亮） */
const props = defineProps<{
  searching: boolean;
  results: SearchHit[] | null;
  query: string;
  onOpen: (hit: SearchHit) => void;
}>();

const count = computed(() => props.results?.length ?? 0);

/** HTML 转义（v-html 输出前必须转义原始文本，防笔记内容注入） */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** 大小写不敏感的关键词高亮（先 split 再逐段转义拼接，与 React 版等价且防注入） */
function highlight(text: string): string {
  const q = props.query;
  if (!q) return esc(text);
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  const lower = q.toLowerCase();
  return parts
    .map((part) => (part.toLowerCase() === lower ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join("");
}
</script>

<template>
  <div class="search-results" aria-live="polite">
    <div class="search-results-header">
      <span>搜索「{{ query }}」{{ searching ? "…" : ` · ${count} 个结果` }}</span>
    </div>
    <div v-if="searching" class="search-hint">检索中…</div>
    <div v-else-if="count === 0" class="search-hint">没有匹配的内容</div>
    <div v-else class="search-list">
      <button
        v-for="hit in results"
        :key="`${hit.source ?? 'file'}:${hit.path}`"
        class="result-item"
        @click="onOpen(hit)"
      >
        <div class="result-title">
          <span v-if="hit.source" class="result-source" title="来自插件搜索提供者">
            {{ hit.source }}
          </span>
          <span v-html="highlight(hit.path)" />
        </div>
        <div class="result-snippet" v-html="highlight(hit.snippet)" />
      </button>
    </div>
  </div>
</template>
