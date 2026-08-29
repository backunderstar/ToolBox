<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * core-example 设置面板（教学点：宿主外壳扩展点——manifest settings.entry）。
 * 宿主设置页「插件设置」段经 PluginUiView(entry="ui/settings.js",
 * regKey="settings:core-example") 注入挂载；与主界面共用同一 api 桥。
 * 演示：读取插件配置（author）+ 订阅外壳动作事件（action）+ 调插件命令。
 * 注意：不写 <style> 块（设置面板复用宿主全局 class + 内联样式，避免
 * 与主界面 style.css 产物冲突）。
 */
const props = defineProps<{ api: PluginBridgeApi }>();

const info = ref<{ plugin: string; vault: string; author: string } | null>(null);
const error = ref<string | null>(null);
/** 外壳动作日志（顶栏按钮/托盘菜单项触发，source 标记来源） */
const actionLog = ref<string[]>([]);

const vaultMissing = computed(() => !props.api.context.vault);

onMounted(() => {
  let alive = true;
  (async () => {
    try {
      info.value = (await props.api.call("example.info")) as typeof info.value;
    } catch (e) {
      if (alive) error.value = String(e);
    }
  })();
  // 订阅外壳动作事件：宿主发 plugin-event `action`（payload {action, source}）
  const un = props.api.on("action", (data) => {
    const d = (data ?? {}) as { action?: string; source?: string };
    actionLog.value = [...actionLog.value, `${d.source ?? "?"} → ${d.action ?? "?"}`].slice(-5);
  });
  onBeforeUnmount(() => {
    alive = false;
    un();
  });
});

/** 演示调插件命令（读取配置回显） */
async function refreshInfo(): Promise<void> {
  try {
    info.value = (await props.api.call("example.info")) as typeof info.value;
    error.value = null;
  } catch (e) {
    error.value = String(e);
  }
}
</script>

<template>
  <div style="display: flex; flex-direction: column; gap: 8px; font-size: 13px">
    <p style="margin: 0; color: var(--fg-muted, #888)">
      本面板由插件提供（manifest
      <code>settings.entry</code>）——任何插件都能在设置页拥有自己的设置区。
    </p>

    <div v-if="error" style="color: var(--color-danger, #c0392b)">{{ error }}</div>

    <div v-if="info" class="settings-row">
      <span class="settings-label">插件配置</span>
      <span class="settings-value">
        作者：{{ info.author }} · 工作区：{{ info.vault || "（未选择）" }}
      </span>
      <button class="btn btn-sm" @click="refreshInfo" :disabled="vaultMissing">刷新</button>
    </div>

    <div class="settings-row">
      <span class="settings-label">外壳动作</span>
      <span class="settings-hint">
        试试顶栏的示例按钮或托盘菜单「示例插件：示例问候」——这里会实时显示触发来源。
      </span>
    </div>
    <div v-if="actionLog.length > 0" style="font-family: ui-monospace, Consolas, monospace; font-size: 12px">
      <div v-for="(e, i) in actionLog" :key="i" style="color: var(--fg-muted, #888)">action: {{ e }}</div>
    </div>
    <div v-else style="color: var(--fg-muted, #888)">（尚未触发外壳动作）</div>
  </div>
</template>
