<script setup lang="ts">
import { ref, watch } from "vue";

/**
 * 应用内确认对话框：替换原生 window.confirm（系统样式、阻塞、暗色下刺眼）。
 * 用法：视图持有 open state，确认后调用回调并关闭。
 * 无障碍：Esc 关闭（与取消等价）、焦点收在对话框内、关闭后焦点归还触发元素。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }>(),
  {
    confirmText: "确认",
    cancelText: "取消",
    danger: false,
  },
);

// 打开时记录焦点触发元素，关闭后归还（键盘用户不会丢失焦点位置）
let restoreEl: HTMLElement | null = null;
const dialogRef = ref<HTMLDivElement | null>(null);
const cancelRef = ref<HTMLButtonElement | null>(null);

watch(
  () => props.open,
  (o, _prev, onCleanup) => {
    if (!o) return;
    restoreEl = document.activeElement as HTMLElement | null;
    // Esc 关闭（与取消等价）；打开时取消按钮获得焦点（安全默认：回车不误触发危险操作）
    cancelRef.value?.focus();
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

/* 焦点陷阱：Tab 在对话框内循环（轻量实现，避免引入焦点管理库） */
function onOverlayKeydown(e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const el = dialogRef.value;
  if (!el) return;
  const focusables = el.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
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
        role="alertdialog"
        aria-modal="true"
        :aria-label="title"
        @click.stop
      >
        <h3 class="confirm-title">{{ title }}</h3>
        <p class="confirm-message">{{ message }}</p>
        <div class="confirm-actions">
          <button ref="cancelRef" class="btn" @click="onCancel">{{ cancelText }}</button>
          <button :class="danger ? 'btn btn-danger' : 'btn'" @click="onConfirm">
            {{ confirmText }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
