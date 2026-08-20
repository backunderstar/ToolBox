<script setup lang="ts">
import { onErrorCaptured, ref } from "vue";

/**
 * 全局错误边界：界面渲染/生命周期出错时显示错误信息而非白屏。
 * （React 版为 class ErrorBoundary；Vue 3 用 onErrorCaptured 实现同等语义。）
 */
const error = ref<Error | null>(null);

onErrorCaptured((err) => {
  console.error("[error-boundary]", err);
  error.value = err instanceof Error ? err : new Error(String(err));
  // 阻止继续向上传播（本组件即最外层）
  return false;
});

function reset(): void {
  error.value = null;
}
</script>

<template>
  <div v-if="error" class="fatal-error">
    <h2>界面发生错误</h2>
    <pre>{{ error.message }}</pre>
    <p>请把上面的错误信息反馈给开发者。</p>
    <button class="btn-primary" @click="reset">重试</button>
  </div>
  <slot v-else />
</template>
