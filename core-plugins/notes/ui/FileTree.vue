<script setup lang="ts">
import { computed, ref } from "vue";
import type { FileEntry } from "./bridge";
import TreeNodeRow from "./TreeNodeRow.vue";

/**
 * 文件树（迁移自宿主 FileTree，Vue 3）：
 * 扁平列表（目录优先、父先于子）→ 树；展开状态、键盘上下导航。
 */
interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

/** 扁平列表（目录优先、父先于子）→ 树 */
function buildTree(entries: FileEntry[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const e of entries) {
    const node: TreeNode = { name: e.name, path: e.path, isDir: e.isDir, children: [] };
    map.set(e.path, node);
    const parts = e.path.split("/");
    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parent = map.get(parts.slice(0, -1).join("/"));
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh") : a.isDir ? -1 : 1,
    );
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const props = defineProps<{
  files: FileEntry[];
  activePath: string | null;
  onOpen: (rel: string) => void;
  onRemove: (rel: string) => void;
  onRename: (from: string, to: string) => void;
}>();

const tree = computed(() => buildTree(props.files));
/** 展开状态：初始全部目录展开 */
const expanded = ref<Set<string>>(
  new Set(props.files.filter((f) => f.isDir).map((f) => f.path)),
);

function toggle(path: string): void {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

/* 扁平可见行（展开的目录含子级）——供键盘上下移动焦点 */
const visiblePaths = computed(() => {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n.path);
      if (n.isDir && expanded.value.has(n.path)) walk(n.children);
    }
  };
  walk(tree.value);
  return out;
});

/** 按 path 聚焦某一行（键盘导航用） */
function focusRow(path: string): void {
  const el = document.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(path)}"]`);
  el?.focus();
}
</script>

<template>
  <div v-if="tree.length === 0" class="tree-empty">
    <p>还没有笔记</p>
    <p class="tree-empty-hint">点击上方「新建笔记」开始</p>
  </div>
  <div v-else class="file-tree" role="tree">
    <TreeNodeRow
      v-for="node in tree"
      :key="node.path"
      :node="node"
      :depth="0"
      :expanded="expanded"
      :active-path="activePath"
      :on-toggle="toggle"
      :on-open="onOpen"
      :on-remove="onRemove"
      :on-rename="onRename"
      :visible-paths="visiblePaths"
      :focus-row="focusRow"
    />
  </div>
</template>
