<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import {
  applyTheme,
  applyThemeStyle,
  upsertCustomTheme,
  getStoredThemeId,
  EDITABLE_TOKENS,
  type ThemeDef,
  type ThemeMode,
} from "../themes/themes";

/**
 * 主题编辑器（M5）：基于某主题副本调色，实时预览，保存为自定义主题。
 * 预览走 applyThemeStyle（不持久化）；保存时 upsertCustomTheme + applyTheme。
 */
const props = defineProps<{
  initial: ThemeDef;
  onCancel: () => void;
  onSaved: (id: string) => void;
}>();

const draft = ref<ThemeDef>(props.initial);
const name = ref(props.initial.name);

/* 进入编辑器时记住当前主题 id：预览 applyThemeStyle 直接污染 documentElement
   （data-theme-id 被改成 draft.id），取消时 App 的 themeId 未变——必须在卸载时
   手动恢复进入前主题。优先读持久化原始值（含 system 跟随模式）。 */
const prevThemeId =
  getStoredThemeId() || document.documentElement.dataset.themeId || "default-light";
onBeforeUnmount(() => {
  // 取消/卸载时完整恢复进入前主题：applyTheme 同时恢复令牌、插件 CSS、
  // 标题栏近似色与持久化。预览只走 applyThemeStyle（仅改 DOM 样式与 data-theme-id，
  // 不触发标题栏近似色/插件 CSS 同步），取消后必须重新应用一次以恢复这些副作用。
  void applyTheme(prevThemeId);
});

/* 实时预览（不持久化）；draft.tokens 嵌套变化需要 deep */
watch(
  draft,
  (d) => applyThemeStyle(d.base, d.id, d.tokens),
  { deep: true },
);

function setToken(key: string, value: string): void {
  draft.value = { ...draft.value, tokens: { ...draft.value.tokens, [key]: value } };
}

function setBase(base: ThemeMode): void {
  draft.value = { ...draft.value, base };
}

function save(): void {
  const def: ThemeDef = {
    ...draft.value,
    name: name.value.trim() || "未命名主题",
    custom: true,
  };
  upsertCustomTheme(def);
  void applyTheme(def.id);
  props.onSaved(def.id);
}

function tokenValue(key: string): string {
  if (draft.value.tokens[key]) return draft.value.tokens[key];
  // 回退到当前计算样式，保证 color input 有初值
  return getComputedStyle(document.documentElement).getPropertyValue(key).trim();
}

/** 把 css 颜色（#rgb/#rrggbb/rgb()/rgba()）统一转成 #rrggbb；无法解析时返回 fallback */
function normalizeHex(value: string, fallback = "#000000"): string {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${Array.from(v.slice(1))
      .map((c) => c + c)
      .join("")}`;
  }
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  if (m) {
    return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  return fallback;
}

const BASES: [ThemeMode, string][] = [
  ["light", "亮"],
  ["dark", "暗"],
];
</script>

<template>
  <div class="theme-editor">
    <div class="theme-editor-head">
      <input
        class="theme-editor-name"
        v-model="name"
        placeholder="主题名称"
        spellcheck="false"
      />
      <span class="tool-option">
        底色
        <label class="segmented segmented-sm">
          <button
            v-for="[b, label] in BASES"
            :key="b"
            class="segmented-item"
            :class="{ active: draft.base === b }"
            @click="setBase(b)"
          >
            {{ label }}
          </button>
        </label>
      </span>
    </div>

    <div class="theme-editor-tokens">
      <label v-for="{ key, label } in EDITABLE_TOKENS" :key="key" class="theme-token-row">
        <span class="theme-token-label">
          {{ label }}
          <code class="theme-token-key">{{ key }}</code>
        </span>
        <input
          type="color"
          class="theme-token-input"
          :value="normalizeHex(tokenValue(key))"
          @input="setToken(key, ($event.target as HTMLInputElement).value)"
        />
        <code class="theme-token-value">{{ tokenValue(key) }}</code>
      </label>
    </div>

    <div class="theme-editor-actions">
      <button class="btn btn-sm" @click="save">保存主题</button>
      <button class="btn btn-sm" @click="onCancel">取消</button>
    </div>
  </div>
</template>
