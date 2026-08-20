<script setup lang="ts">
import { ref } from "vue";
import { exportThemesJson, importThemesJson } from "../themes/themes";

/** 主题导出/导入面板：导出 = 复制 JSON；导入 = 粘贴 JSON 后应用。 */
const props = defineProps<{ onDone: () => void }>();

const exported = ref(exportThemesJson());
const importText = ref("");
const msg = ref<string | null>(null);
const msgErr = ref(false);

async function copyExport(): Promise<void> {
  try {
    await navigator.clipboard.writeText(exported.value);
    msg.value = "已复制到剪贴板";
    msgErr.value = false;
  } catch {
    msg.value = "复制失败：请手动选择文本复制";
    msgErr.value = true;
  }
}

function doImport(): void {
  try {
    const n = importThemesJson(importText.value);
    msg.value = `导入成功：${n} 个主题`;
    msgErr.value = false;
    props.onDone();
  } catch (e) {
    msg.value = String(e);
    msgErr.value = true;
  }
}
</script>

<template>
  <div class="theme-io">
    <div class="settings-row">
      <span class="settings-label">导出</span>
      <div class="settings-actions" style="flex: 1; min-width: 0">
        <textarea
          class="theme-io-textarea"
          readonly
          v-model="exported"
          rows="4"
          placeholder="（暂无自定义主题）"
        />
        <button class="btn btn-sm" @click="copyExport" :disabled="!exported.trim()">
          复制
        </button>
      </div>
    </div>
    <div class="settings-row">
      <span class="settings-label">导入</span>
      <div class="settings-actions" style="flex: 1; min-width: 0">
        <textarea
          class="theme-io-textarea"
          v-model="importText"
          rows="4"
          placeholder="粘贴主题 JSON（从其他机器导出的文本）"
        />
        <button class="btn btn-sm" @click="doImport" :disabled="!importText.trim()">
          应用
        </button>
      </div>
    </div>
    <p v-if="msg" class="settings-message" :class="msgErr ? 'err' : 'ok'">{{ msg }}</p>
  </div>
</template>
