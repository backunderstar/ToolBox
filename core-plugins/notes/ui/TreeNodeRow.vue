<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

/**
 * 文件树行（Vue 3，递归自引用）：展开/打开/重命名/两段式删除 + 键盘导航。
 */
interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

const props = defineProps<{
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpen: (rel: string) => void;
  onRemove: (rel: string) => void;
  onRename: (from: string, to: string) => void;
  visiblePaths: string[];
  focusRow: (path: string) => void;
}>();

const editing = ref(false);
const editValue = ref(props.node.name);
const confirming = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);
let confirmTimer: ReturnType<typeof setTimeout> | null = null;

watch(editing, async (v) => {
  if (v) {
    await nextTick();
    inputRef.value?.select();
  }
});

onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer);
});

const isOpen = computed(() => props.expanded.has(props.node.path));
const isActive = computed(() => props.node.path === props.activePath);
const indent = computed(() => ({ paddingLeft: `${8 + props.depth * 14}px` }));

const parentOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

function commitRename(): void {
  editing.value = false;
  let name = editValue.value.trim();
  if (!name || name === props.node.name) return;
  if (!name.endsWith(".md")) name += ".md";
  const parent = parentOf(props.node.path);
  const to = parent ? `${parent}/${name}` : name;
  props.onRename(props.node.path, to);
}

/* Enter/Escape 与 onBlur 叠加：blur 在输入框卸载后也会触发，
   用标记防二次提交（Enter 后 blur / Escape 后 blur） */
let handled = false;

function commitOrCancel(cancel: boolean): void {
  if (handled) return;
  handled = true;
  if (cancel) editing.value = false;
  else commitRename();
}

function startEdit(): void {
  handled = false;
  editValue.value = props.node.name;
  editing.value = true;
}

function askDelete(): void {
  if (confirming.value) {
    props.onRemove(props.node.path);
    return;
  }
  confirming.value = true;
  confirmTimer = setTimeout(() => (confirming.value = false), 3000);
}

/* 键盘导航：↑↓ 在可见行间移动焦点；→ 展开 / ← 收起目录；Enter/Space 打开 */
function onRowKeyDown(e: KeyboardEvent): void {
  if (editing.value) return;
  const idx = props.visiblePaths.indexOf(props.node.path);
  if (e.key === "ArrowDown" && idx >= 0 && idx < props.visiblePaths.length - 1) {
    e.preventDefault();
    props.focusRow(props.visiblePaths[idx + 1]);
  } else if (e.key === "ArrowUp" && idx > 0) {
    e.preventDefault();
    props.focusRow(props.visiblePaths[idx - 1]);
  } else if (e.key === "ArrowRight" && props.node.isDir && !isOpen.value) {
    e.preventDefault();
    props.onToggle(props.node.path);
  } else if (e.key === "ArrowLeft" && props.node.isDir && isOpen.value) {
    e.preventDefault();
    props.onToggle(props.node.path);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (props.node.isDir) props.onToggle(props.node.path);
    else props.onOpen(props.node.path);
  }
}
</script>

<template>
  <div>
    <div
      class="tree-row"
      :class="{ active: isActive }"
      :style="indent"
      role="treeitem"
      :aria-selected="isActive"
      :aria-expanded="node.isDir ? isOpen : undefined"
      tabindex="0"
      :data-path="node.path"
      @click="node.isDir ? onToggle(node.path) : onOpen(node.path)"
      @keydown="onRowKeyDown"
    >
      <span class="tree-chevron">
        <svg
          v-if="node.isDir && isOpen"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <svg
          v-else-if="node.isDir"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
      <span class="tree-icon">
        <svg
          v-if="node.isDir"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M3.5 6.5h6l2 2.5h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        </svg>
        <svg
          v-else
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
          <path d="M9 12h6M9 16h6" />
        </svg>
      </span>
      <input
        v-if="editing"
        ref="inputRef"
        class="tree-input"
        v-model="editValue"
        @click.stop
        @keydown.enter="commitOrCancel(false)"
        @keydown.esc="commitOrCancel(true)"
        @blur="commitOrCancel(handled)"
      />
      <span
        v-else
        class="tree-name"
        :title="node.path"
        @dblclick.stop="startEdit"
      >
        {{ node.name }}
      </span>
      <span v-if="!node.isDir && !editing" class="tree-actions" @click.stop>
        <button
          class="tree-action"
          :class="{ danger: confirming }"
          :title="confirming ? '再次点击确认删除' : '删除'"
          :aria-label="confirming ? '确认删除' : `删除 ${node.name}`"
          @click="askDelete"
        >
          <template v-if="confirming">确认?</template>
          <svg
            v-else
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
      </span>
    </div>
    <div v-if="node.isDir && isOpen && node.children.length > 0">
      <TreeNodeRow
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :expanded="expanded"
        :active-path="activePath"
        :on-toggle="onToggle"
        :on-open="onOpen"
        :on-remove="onRemove"
        :on-rename="onRename"
        :visible-paths="visiblePaths"
        :focus-row="focusRow"
      />
    </div>
  </div>
</template>
