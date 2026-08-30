<script setup lang="ts">
import { ref } from "vue";
import Icon from "./Icon.vue";

/**
 * 插件命令试用组件：命令胶囊 + 展开的 JSON 参数台。
 * 在插件管理页使用；invoke 由调用方注入（mock / 真实路由）。
 */

/** 常用示例命令的默认测试参数 */
const EXAMPLE_ARGS: Record<string, string> = {
  "core-example:example.echo": JSON.stringify({ name: "小明" }, null, 2),
  "py-tools:pytext.stats": JSON.stringify(
    { text: "你好，世界！hello world" },
    null,
    2,
  ),
};

const props = defineProps<{
  pluginId: string;
  command: string;
  name: string;
  invoke: (pluginId: string, command: string, args: unknown) => Promise<unknown>;
}>();

const open = ref(false);
const argsText = ref(EXAMPLE_ARGS[`${props.pluginId}:${props.command}`] ?? "{}");
const result = ref<{ ok: boolean; text: string } | null>(null);
const running = ref(false);

function toggle(): void {
  open.value = !open.value;
  result.value = null;
  if (!open.value) {
    argsText.value = EXAMPLE_ARGS[`${props.pluginId}:${props.command}`] ?? "{}";
  }
}

async function run(): Promise<void> {
  if (running.value) return;
  running.value = true;
  result.value = null;
  try {
    let args: unknown = {};
    if (argsText.value.trim()) {
      args = JSON.parse(argsText.value);
    }
    const out = await props.invoke(props.pluginId, props.command, args);
    result.value = { ok: true, text: JSON.stringify(out, null, 2) };
  } catch (e) {
    result.value = { ok: false, text: String(e) };
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <span class="command-chip">
    <span class="command-name">{{ name }}</span>
    <button
      class="command-try"
      @click="toggle"
      :title="`${open ? '收起' : '调用'} ${command}`"
      :aria-label="`${open ? '收起' : '调用'} ${command}`"
      :aria-expanded="open"
    >
      <Icon name="plus" :size="11" />
      {{ open ? "收起" : "试用" }}
    </button>
  </span>
  <div v-if="open" class="try-panel">
    <div class="try-head">
      <span class="try-title">
        调用命令 <code>{{ command }}</code>
      </span>
      <button class="btn btn-sm" @click="run" :disabled="running">
        {{ running ? "运行中…" : "运行" }}
      </button>
    </div>
    <textarea
      class="try-args"
      v-model="argsText"
      spellcheck="false"
      placeholder='JSON 参数，如 {"text": "你好"}'
    />
    <pre v-if="result" class="try-result" :class="result.ok ? 'ok' : 'err'">{{ result.text }}</pre>
  </div>
</template>
