<script setup lang="ts">
import { ref, watch } from "vue";

/**
 * 应用内文本输入对话框：替换原生 window.prompt（系统样式、阻塞、暗色下刺眼），
 * 与 ConfirmDialog 同风格（复用 .confirm-* 框架类）。用于新建/重命名/复制到等命名输入。
 * 无障碍：Esc 关闭（与取消等价）、焦点收在输入框内、关闭后焦点归还触发元素。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message?: string;
    placeholder?: string;
    initial?: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: (value: string) => void;
    onCancel: () => void;
  }>(),
  {
    message: "",
    placeholder: "",
    initial: "",
    confirmText: "确认",
    cancelText: "取消",
  },
);

const value = ref(props.initial);
const inputRef = ref<HTMLInputElement | null>(null);
const dialogRef = ref<HTMLDivElement | null>(null);
let restoreEl: HTMLElement | null = null;

watch(
  () => props.open,
  (o, _prev, onCleanup) => {
    if (!o) return;
    restoreEl = document.activeElement as HTMLElement | null;
    value.value = props.initial;
    // 打开后聚焦输入框并全选（便于直接输入替换默认值）
    requestAnimationFrame(() => {
      inputRef.value?.focus();
      inputRef.value?.select();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      restoreEl?.focus?.();
      restoreEl = null;
    });
  },
);

/* 焦点陷阱：Tab 在对话框内循环（与 ConfirmDialog 一致） */
function onOverlayKeydown(e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const el = dialogRef.value;
  if (!el) return;
  const focusables = el.querySelectorAll<HTMLElement>(
    'input, button, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
</script>

<template>
  <Transition name="modal">
    <div
      v-if="open"
      class="confirm-overlay"
      @click="onCancel"
      @keydown="onOverlayKeydown"
    >
      <div
        ref="dialogRef"
        class="confirm-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        @click.stop
      >
        <h3 class="confirm-title">{{ title }}</h3>
        <p v-if="message" class="confirm-message">{{ message }}</p>
        <form
          class="confirm-form"
          @submit.prevent="onConfirm(value)"
        >
          <input
            ref="inputRef"
            v-model="value"
            class="confirm-input"
            :placeholder="placeholder"
            :aria-label="title"
            spellcheck="false"
            autocomplete="off"
          />
          <div class="confirm-actions">
            <button type="button" class="btn" @click="onCancel">{{ cancelText }}</button>
            <button type="submit" class="btn">{{ confirmText }}</button>
          </div>
        </form>
      </div>
    </div>
  </Transition>
</template>
