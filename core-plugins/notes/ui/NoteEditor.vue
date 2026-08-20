<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { MdEditor } from "md-editor-v3";
import "md-editor-v3/lib/style.css";
import type { PluginBridgeApi } from "./bridge";

/**
 * 笔记编辑器（md-editor-v3，Vue 3 生态）：
 * 主题跟随、自动保存（input 防抖由父组件处理）、AI 摘要（跨插件 core-ai）。
 * 父组件以 :key="activePath" 重建本组件，doc 仅作挂载初始值。
 */
const props = defineProps<{
  api: PluginBridgeApi;
  doc: string;
  onChange: (doc: string) => void;
  onSave: () => void;
  dark: boolean;
  onFlash: (msg: string, err?: boolean) => void;
  placeholderText?: string;
}>();

const editorRef = ref<InstanceType<typeof MdEditor> | null>(null);
const text = ref(props.doc);
const aiBusy = ref(false);
let aiBusyGuard = false;

watch(text, (v) => props.onChange(v));

/** M6：选中文本 → AI 摘要 → 以引用块替换选区（跨插件 core-ai） */
async function handleAiSummary(): Promise<void> {
  if (aiBusyGuard) return;
  const sel = editorRef.value?.getSelectedText() ?? "";
  if (!sel.trim()) {
    props.onFlash("请先在编辑器中选中要摘要的文本");
    return;
  }
  aiBusyGuard = true;
  aiBusy.value = true;
  try {
    const reply = (await props.api.call(
      "ai.chat",
      {
        messages: [
          {
            role: "system",
            content: "你是精炼的摘要助手。用 3-5 条要点总结用户文本，使用中文，只输出摘要。",
          },
          { role: "user", content: sel.slice(0, 6000) },
        ],
      },
      "core-ai",
    )) as string;
    const block = `\n\n> **AI 摘要**\n${reply
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n")}\n`;
    editorRef.value?.insert(block);
  } catch (e) {
    const msg = String(e);
    props.onFlash(
      msg.includes("未配置 API Key") ? "未配置 AI —— 请到设置页填写" : msg.slice(0, 80),
      true,
    );
  } finally {
    aiBusyGuard = false;
    aiBusy.value = false;
  }
}

/* 工具栏：映射原 Vditor 布局到 md-editor-v3 预置工具；0 = 自定义 AI 摘要 */
const toolbars = [
  "revoke",
  "next",
  "-",
  "title",
  "bold",
  "italic",
  "strike-through",
  "-",
  "unordered-list",
  "ordered-list",
  "task",
  "-",
  "quote",
  "code-row",
  "code",
  "link",
  "table",
  "-",
  0,
] as const;

const defToolbars = computed(() => [
  {
    name: "ai-summary",
    icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z"/></svg>',
    tip: aiBusy.value ? "AI 摘要生成中…" : "AI 摘要（选中文本）",
    onclick: () => void handleAiSummary(),
  },
]);
</script>

<template>
  <MdEditor
    ref="editorRef"
    v-model="text"
    :theme="dark ? 'dark' : 'light'"
    language="zh-CN"
    :placeholder="placeholderText"
    :toolbars="toolbars"
    :def-toolbars="defToolbars"
    :on-save="onSave"
    :style="{ height: '100%' }"
  />
</template>
