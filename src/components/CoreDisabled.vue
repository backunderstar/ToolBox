<script setup lang="ts">
import { useNav } from "../core/navigation";

/** 核心插件被禁用时的占位（引导去插件页启用）。 */
defineProps<{ name: string }>();

const nav = useNav();
</script>

<template>
  <div class="empty-state">
    <h2>{{ name }}功能已禁用</h2>
    <p>该功能是核心插件，可在插件页重新启用</p>
    <button class="btn" @click="nav.go('plugins')">去插件页</button>
  </div>
</template>
