<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useVault } from "../core/vault";
import { fsCreate, fsDelete, fsList, fsMkdir, fsRename, openInExplorer } from "../core/api";
import type { FileEntry } from "../core/api";
import { openPath } from "@tauri-apps/plugin-opener";
import Icon from "../components/Icon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";

/**
 * 工作区文件浏览（2026-09 最小版）：浏览当前工作区文件树（目录优先、按名排序），
 * 打开文件（系统默认程序）/ 进入目录 / 返回 / 新建文件夹 / 新建文件 / 重命名 /
 * 删除（回收站）/ 在资源管理器中打开当前目录。切换工作区后自动回到根。
 * 所有操作走宿主 files_* 命令（S1c vault 作用域校验，只能动当前工作区）。
 */
const vault = useVault();

/** 当前目录（vault 相对路径，空 = 工作区根） */
const dir = ref("");
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const error = ref("");

/** 待确认删除的条目 */
const confirmDel = ref<FileEntry | null>(null);
const deleting = ref(false);

const crumbs = computed(() => (dir.value ? dir.value.split("/") : []));

/** 目录在前、文件在后（files_list 按 path 全量排序，前端再分层） */
const sorted = computed(() => {
  const dirs = entries.value.filter((e) => e.isDir);
  const files = entries.value.filter((e) => !e.isDir);
  return [...dirs, ...files];
});

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 拼绝对路径（opener 需要绝对路径；files_* 命令用相对路径） */
function abs(rel: string): string {
  return `${vault.state.path}/${rel}`;
}

async function reload(): Promise<void> {
  if (!vault.state.path) return;
  loading.value = true;
  error.value = "";
  try {
    entries.value = await fsList(vault.state.path, dir.value);
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

/* 切换工作区 → 回到根重新浏览 */
watch(
  () => vault.state.path,
  () => {
    dir.value = "";
    void reload();
  },
  { immediate: true },
);

function enter(name: string): void {
  dir.value = dir.value ? `${dir.value}/${name}` : name;
  void reload();
}
function gotoCrumb(i: number): void {
  dir.value = crumbs.value.slice(0, i + 1).join("/");
  void reload();
}
function back(): void {
  if (crumbs.value.length === 0) return;
  dir.value = crumbs.value.slice(0, -1).join("/");
  void reload();
}
function toRoot(): void {
  dir.value = "";
  void reload();
}

async function openEntry(e: FileEntry): Promise<void> {
  if (e.isDir) {
    enter(e.name);
    return;
  }
  try {
    await openPath(abs(e.path));
  } catch (err) {
    vault.state.status = `打开失败: ${err}`;
  }
}

async function newFolder(): Promise<void> {
  const name = window.prompt("新建文件夹名称：");
  if (!name || !vault.state.path) return;
  try {
    const rel = dir.value ? `${dir.value}/${name}` : name;
    await fsMkdir(vault.state.path, rel);
    vault.state.status = `已创建文件夹「${name}」`;
    void reload();
  } catch (e) {
    vault.state.status = String(e);
  }
}

async function newFile(): Promise<void> {
  const name = window.prompt("新建文件名称（含扩展名）：");
  if (!name || !vault.state.path) return;
  try {
    const rel = dir.value ? `${dir.value}/${name}` : name;
    await fsCreate(vault.state.path, rel);
    vault.state.status = `已创建文件「${name}」`;
    void reload();
  } catch (e) {
    vault.state.status = String(e);
  }
}

async function renameEntry(e: FileEntry): Promise<void> {
  const name = window.prompt("重命名为：", e.name);
  if (!name || name === e.name || !vault.state.path) return;
  try {
    const to = dir.value ? `${dir.value}/${name}` : name;
    await fsRename(vault.state.path, e.path, to);
    vault.state.status = `已重命名为「${name}」`;
    void reload();
  } catch (err) {
    vault.state.status = String(err);
  }
}

async function confirmDelete(): Promise<void> {
  if (!confirmDel.value || !vault.state.path) return;
  deleting.value = true;
  try {
    await fsDelete(vault.state.path, confirmDel.value.path);
    vault.state.status = `已删除「${confirmDel.value.name}」（回收站可恢复）`;
    confirmDel.value = null;
    void reload();
  } catch (e) {
    vault.state.status = String(e);
  } finally {
    deleting.value = false;
  }
}

function openHere(): void {
  if (!vault.state.path) return;
  void openInExplorer(dir.value ? abs(dir.value) : vault.state.path);
}
</script>

<template>
  <div class="files-view">
    <header class="files-header">
      <div class="files-title">
        <h2 class="view-title">文件</h2>
        <span class="files-ws" :title="vault.state.path ?? undefined">
          {{ vault.state.path ?? "未选择工作区" }}
        </span>
      </div>
      <div class="files-actions">
        <button class="btn sm" @click="toRoot" title="回到工作区根">根</button>
        <button class="btn sm" @click="back" :disabled="crumbs.length === 0">返回</button>
        <button class="btn sm" @click="newFolder" :disabled="!vault.state.path">
          <Icon name="plus" :size="12" /> 新建文件夹
        </button>
        <button class="btn sm" @click="newFile" :disabled="!vault.state.path">
          <Icon name="file-text" :size="12" /> 新建文件
        </button>
        <button class="btn sm" @click="openHere" :disabled="!vault.state.path">
          <Icon name="folder" :size="12" /> 在资源管理器中打开
        </button>
      </div>
    </header>

    <nav v-if="crumbs.length > 0" class="files-crumbs">
      <button class="crumb" @click="toRoot">工作区</button>
      <template v-for="(c, i) in crumbs" :key="i">
        <span class="crumb-sep">/</span>
        <button class="crumb" @click="gotoCrumb(i)">{{ c }}</button>
      </template>
    </nav>

    <p v-if="!vault.state.path" class="module-empty">请先在顶栏或设置页选择工作区</p>
    <p v-else-if="error" class="module-empty warn">{{ error }}</p>
    <p v-else-if="loading" class="module-empty">加载中…</p>
    <p v-else-if="sorted.length === 0" class="module-empty">（空目录）</p>
    <ul v-else class="files-list">
      <li v-for="e in sorted" :key="e.path">
        <button class="file-row" :class="{ dir: e.isDir }" @click="openEntry(e)" :title="e.path">
          <Icon :name="e.isDir ? 'folder' : 'file-text'" :size="14" />
          <span class="file-name">{{ e.name }}</span>
          <span v-if="!e.isDir && e.size != null" class="file-size">{{ fmtSize(e.size) }}</span>
          <span class="file-ops" @click.stop>
            <button class="op" title="重命名" @click="renameEntry(e)">
              <Icon name="refresh" :size="12" />
            </button>
            <button class="op" title="删除（回收站）" @click="confirmDel = e">
              <Icon name="trash" :size="12" />
            </button>
          </span>
        </button>
      </li>
    </ul>

    <ConfirmDialog
      :open="confirmDel !== null"
      title="删除"
      :message="confirmDel ? `确定删除「${confirmDel.name}」？会移入系统回收站，可恢复。` : ''"
      :busy="deleting"
      :danger="true"
      :on-confirm="confirmDelete"
      :on-cancel="() => (confirmDel = null)"
    />
  </div>
</template>

<style scoped>
.files-view {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
}
.files-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.files-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.files-ws {
  font-size: 12px;
  color: var(--fg-faint, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}
.files-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.files-crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  overflow-x: auto;
  padding: 2px 0;
}
.crumb {
  background: none;
  border: none;
  color: var(--fg, #333);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 12px;
}
.crumb:hover {
  background: var(--bg-hover, #f0f0f0);
}
.crumb-sep {
  color: var(--fg-faint, #999);
}
.files-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 8px;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border, #eee);
  color: var(--fg, #333);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
.file-row:last-child {
  border-bottom: none;
}
.file-row:hover {
  background: var(--bg-hover, #f5f5f5);
}
.file-row.dir .file-name {
  font-weight: 500;
}
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size {
  font-size: 11px;
  color: var(--fg-faint, #999);
}
.file-ops {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.file-row:hover .file-ops {
  opacity: 1;
}
.op {
  background: none;
  border: none;
  color: var(--fg-faint, #888);
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
}
.op:hover {
  background: var(--bg-hover, #e8e8e8);
  color: var(--fg, #333);
}
</style>
