<script setup lang="ts">
import { computed } from "vue";
import { ICON_PATHS, FALLBACK_ICON } from "./icons";

/**
 * 图标渲染组件：按名字查 ICON_PATHS 渲染内联 SVG。
 * 统一 1.6 描边、圆头端点，随 currentColor 着色。
 */
const props = withDefaults(defineProps<{ name: string; size?: number }>(), {
  size: 16,
});

const inner = computed(() => ICON_PATHS[props.name] ?? ICON_PATHS[FALLBACK_ICON]);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    v-html="inner"
  />
</template>
