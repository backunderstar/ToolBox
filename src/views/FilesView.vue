<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useVault } from "../core/vault";
import { usePlugins, triggerPluginAction } from "../core/plugins";
import { fsCopy, fsCreate, fsDelete, fsList, fsMkdir, fsMove, fsRename, openInExplorer } from "../core/api";
import type { FileEntry } from "../core/api";
import { openPath } from "@tauri-apps/plugin-opener";
import Icon from "../components/Icon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";

/**
 * 工作区文件浏览（2026-09 数据根模型）。
 * 宿主提供文件处理基础能力（浏览/新建/重命名/移动/复制/删除/搜索/批量，S1c 只作用于
 * 当前工作区）；插件决定文件处理的业务逻辑——右键/批量菜单的「插件处理」二级菜单
 * 列出所有插件的文件上下文动作（manifest actions 中 file:true），插件多也不占地方。
 */
const vault = useVault();
const pluginsCtx = usePlugins();

/** 当前目录（工作区相对路径，空 = 工作区根） */
const dir = ref("");
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const error = ref("");

/** 排序：字段 + 方向（1 升 / -1 降） */
const sortBy = ref<"name" | "mtime" | "size">("name");
const sortDir = ref<1 | -1>(1);

/** 选择模式 + 已选条目（key = rel 路径） */
const selMode = ref(false);
const selected = ref<Set<string>>(new Set());

/** 右键菜单（null = 关闭）；ctxSub = 是否展开「插件处理」二级菜单 */
const ctx = ref<{ x: number; y: number; entry: FileEntry } | null>(null);
const ctxSub = ref(false);

/** 批量操作条的插件动作下拉是否展开 */
const batchPluginsOpen = ref(false);

/** 待确认删除（单项或批量） */
const confirmDel = ref<{ label: string; rels: string[] } | null>(null);
const deleting = ref(false);

const crumbs = computed(() => (dir.value ? dir.value.split("/") : []));

/** 启用的插件声明的文件上下文动作（file:true） */
const fileActions = computed(() =>
  pluginsCtx.state.plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      (p.actions ?? [])
        .filter((a) => a.file)
        .map((a) => ({ pluginId: p.id, pluginName: p.name, action: a })),
    ),
);

/** 当前操作目标：右键选中项（若在选择集内则整个选择集），否则选择集 */
const targetRels = computed<string[]>(() => {
  if (!ctx.value) return [...selected.value];
  if (selMode.value && selected.value.has(ctx.value.entry.path)) return [...selected.value];
  return [ctx.value.entry.path];
});

const sorted = computed(() => {
  const dirs = entries.value.filter((e) => e.isDir);
  const files = entries.value.filter((e) => !e.isDir);
  const cmp = (a: FileEntry, b: FileEntry): number => {
    if (sortBy.value === "mtime") return ((a.mtime ?? 0) - (b.mtime ?? 0)) * sortDir.value;
    if (sortBy.value === "size") return ((a.size ?? 0) - (b.size ?? 0)) * sortDir.value;
    return a.name.localeCompare(b.name, "zh") * sortDir.value;
  };
  return [...dirs.sort(cmp), ...files.sort(cmp)];
});

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtRelTime(mtime?: number | null): string {
  if (!mtime || mtime <= 0) return "";
  const diff = Date.now() - mtime;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

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

/* 切换工作区 → 回到根重新浏览并清空选择 */
watch(
  () => vault.state.path,
  () => {
    dir.value = "";
    selected.value = new Set();
    selMode.value = false;
    ctx.value = null;
    ctxSub.value = false;
    batchPluginsOpen.value = false;
    void reload();
  },
  { immediate: true },
);

function toggleSort(field: "name" | "mtime" | "size"): void {
  if (sortBy.value === field) sortDir.value = sortDir.value === 1 ? -1 : 1;
  else {
    sortBy.value = field;
    sortDir.value = 1;
  }
}
function toggleSelect(e: FileEntry): void {
  const s = new Set(selected.value);
  if (s.has(e.path)) s.delete(e.path);
  else s.add(e.path);
  selected.value = s;
}
function clearSelection(): void {
  selected.value = new Set();
  selMode.value = false;
}
function closeCtx(): void {
  ctx.value = null;
  ctxSub.value = false;
}

function enter(name: string): void {
  dir.value = dir.value ? `${dir.value}/${name}` : name;
  selected.value = new Set();
  void reload();
}
function gotoCrumb(i: number): void {
  dir.value = crumbs.value.slice(0, i + 1).join("/");
  selected.value = new Set();
  void reload();
}
function back(): void {
  if (crumbs.value.length === 0) return;
  dir.value = crumbs.value.slice(0, -1).join("/");
  selected.value = new Set();
  void reload();
}
function toRoot(): void {
  dir.value = "";
  selected.value = new Set();
  void reload();
}

function onClickRow(e: FileEntry): void {
  if (selMode.value) {
    toggleSelect(e);
    return;
  }
  if (e.isDir) enter(e.name);
  else void openEntry(e);
}

async function openEntry(e: FileEntry): Promise<void> {
  try {
    await openPath(abs(e.path));
  } catch (err) {
    vault.state.status = `打开失败: ${err}`;
  }
}

function onContextMenu(e: MouseEvent, entry: FileEntry): void {
  e.preventDefault();
  ctx.value = { x: e.clientX, y: e.clientY, entry };
  ctxSub.value = false;
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

/** 复制/移动到目标目录（prompt 相对工作区根的目录；空 = 工作区根） */
async function copyMove(kind: "copy" | "move"): Promise<void> {
  const rels = targetRels.value;
  if (rels.length === 0 || !vault.state.path) return;
  const hint = kind === "copy" ? "复制到" : "移动到";
  const target = window.prompt(`${hint}目录（相对工作区根，留空 = 工作区根；如 docs/2024）:`, "");
  if (target === null) return;
  const base = target.trim().replace(/\/+$/, "");
  try {
    for (const rel of rels) {
      const name = rel.split("/").pop() ?? rel;
      const to = base ? `${base}/${name}` : name;
      if (kind === "copy") await fsCopy(vault.state.path, rel, to);
      else await fsMove(vault.state.path, rel, to);
    }
    vault.state.status = `${hint}完成（${rels.length} 项 → ${base || "工作区根"}）`;
    clearSelection();
    void reload();
  } catch (e) {
    vault.state.status = String(e);
  }
}

function askDelete(): void {
  const rels = targetRels.value;
  if (rels.length === 0) return;
  confirmDel.value = { label: rels.length === 1 ? rels[0] : `${rels.length} 项`, rels };
}

async function confirmDelete(): Promise<void> {
  if (!confirmDel.value || !vault.state.path) return;
  deleting.value = true;
  try {
    for (const rel of confirmDel.value.rels) {
      await fsDelete(vault.state.path, rel);
    }
    vault.state.status = `已删除「${confirmDel.value.label}」（回收站可恢复）`;
    confirmDel.value = null;
    clearSelection();
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

/** 触发插件文件上下文动作（source = "file"，带选中 rel 列表） */
async function runPluginAction(pluginId: string, actionId: string): Promise<void> {
  const rels = targetRels.value;
  closeCtx();
  batchPluginsOpen.value = false;
  if (rels.length === 0) return;
  await triggerPluginAction(pluginId, actionId, "file", rels);
  vault.state.status = `已调用插件动作「${actionId}」（${rels.length} 项）`;
  void reload();
}
</script>

<template>
  <div class="files-view" @click="closeCtx">
    <header class="view-header">
      <div>
        <h1>文件</h1>
        <p class="view-sub">浏览当前工作区的文件；插件可处理选中文件（右键「插件处理」）</p>
      </div>
      <div class="view-actions">
        <button class="btn" @click="toRoot" title="回到工作区根" :disabled="!vault.state.path">根</button>
        <button class="btn" @click="back" :disabled="crumbs.length === 0">返回</button>
        <button
          class="btn"
          :class="{ on: selMode }"
          @click="selMode = !selMode"
          :disabled="!vault.state.path || entries.length === 0"
          title="勾选多个文件后批量操作"
        >
          选择
        </button>
        <button class="btn" @click="newFolder" :disabled="!vault.state.path">新建文件夹</button>
        <button class="btn" @click="newFile" :disabled="!vault.state.path">新建文件</button>
        <button class="btn" @click="openHere" :disabled="!vault.state.path">在资源管理器中打开</button>
      </div>
    </header>

    <nav v-if="crumbs.length > 0" class="files-crumbs">
      <button class="crumb" @click="toRoot">工作区</button>
      <template v-for="(c, i) in crumbs" :key="i">
        <span class="crumb-sep">/</span>
        <button class="crumb" @click="gotoCrumb(i)">{{ c }}</button>
      </template>
    </nav>

    <div class="files-toolbar">
      <span class="files-sort-label">排序</span>
      <button class="sort-btn" :class="{ on: sortBy === 'name' }" @click="toggleSort('name')">
        名称 {{ sortBy === "name" ? (sortDir === 1 ? "↑" : "↓") : "" }}
      </button>
      <button class="sort-btn" :class="{ on: sortBy === 'mtime' }" @click="toggleSort('mtime')">
        时间 {{ sortBy === "mtime" ? (sortDir === 1 ? "↑" : "↓") : "" }}
      </button>
      <button class="sort-btn" :class="{ on: sortBy === 'size' }" @click="toggleSort('size')">
        大小 {{ sortBy === "size" ? (sortDir === 1 ? "↑" : "↓") : "" }}
      </button>
    </div>

    <p v-if="!vault.state.path" class="module-empty">请先在设置页或引导页配置数据根目录并选择工作区</p>
    <p v-else-if="error" class="module-empty warn">{{ error }}</p>
    <p v-else-if="loading" class="module-empty">加载中…</p>
    <p v-else-if="sorted.length === 0" class="module-empty">（空目录）</p>
    <ul v-else class="files-list">
      <li
        v-for="e in sorted"
        :key="e.path"
        :class="{ selected: selected.has(e.path) }"
        @contextmenu.prevent="onContextMenu($event, e)"
      >
        <button class="file-row" :class="{ dir: e.isDir }" @click="onClickRow(e)" :title="e.path">
          <span v-if="selMode" class="file-check" @click.stop="toggleSelect(e)">
            <Icon :name="selected.has(e.path) ? 'check' : 'plus'" :size="13" />
          </span>
          <Icon :name="e.isDir ? 'folder' : 'file-text'" :size="14" />
          <span class="file-name">{{ e.name }}</span>
          <span v-if="!e.isDir && e.size != null" class="file-size">{{ fmtSize(e.size) }}</span>
          <span class="file-time">{{ fmtRelTime(e.mtime) }}</span>
          <span class="file-ops" @click.stop>
            <button class="op" title="重命名" @click="renameEntry(e)">
              <Icon name="refresh" :size="12" />
            </button>
            <button class="op" title="删除（回收站）" @click="askDelete">
              <Icon name="trash" :size="12" />
            </button>
          </span>
        </button>
      </li>
    </ul>

    <!-- 底部批量操作条：有选中项时出现 -->
    <div v-if="selected.size > 0" class="files-actionbar">
      <span class="actionbar-count">已选 {{ selected.size }} 项</span>
      <button class="btn" @click="copyMove('copy')">复制到…</button>
      <button class="btn" @click="copyMove('move')">移动到…</button>
      <button class="btn danger" @click="askDelete">删除</button>
      <div v-if="fileActions.length > 0" class="batch-plugins">
        <button class="btn" @click="batchPluginsOpen = !batchPluginsOpen">
          插件处理 ▾
        </button>
        <div v-if="batchPluginsOpen" class="batch-plugins-menu" @click.stop>
          <button
            v-for="fa in fileActions"
            :key="`${fa.pluginId}:${fa.action.id}`"
            class="ctx-item"
            @click="runPluginAction(fa.pluginId, fa.action.id)"
          >
            <Icon :name="fa.action.icon || 'puzzle'" :size="13" />
            <span class="ctx-item-label">{{ fa.action.label }}</span>
            <span class="ctx-item-src">{{ fa.pluginName }}</span>
          </button>
        </div>
      </div>
      <button class="btn" @click="clearSelection">取消</button>
    </div>

    <!-- 右键菜单：宿主操作 + 「插件处理」二级菜单 -->
    <div
      v-if="ctx"
      class="files-ctx"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
    >
      <template v-if="targetRels.length === 1">
        <button class="ctx-item" @click="openEntry(ctx.entry)">
          <Icon name="file-text" :size="13" /> 打开
        </button>
        <button class="ctx-item" @click="renameEntry(ctx.entry)">
          <Icon name="refresh" :size="13" /> 重命名
        </button>
      </template>
      <button class="ctx-item" @click="copyMove('copy')">
        <Icon name="plus" :size="13" /> 复制到…
      </button>
      <button class="ctx-item" @click="copyMove('move')">
        <Icon name="folder" :size="13" /> 移动到…
      </button>
      <button class="ctx-item danger" @click="askDelete">
        <Icon name="trash" :size="13" /> 删除
      </button>
      <button v-if="fileActions.length > 0" class="ctx-item" @click="ctxSub = !ctxSub">
        <Icon name="puzzle" :size="13" /> 插件处理
        <span class="ctx-chevron">{{ ctxSub ? "▴" : "▸" }}</span>
      </button>
      <div v-if="ctxSub && fileActions.length > 0" class="ctx-sub">
        <button
          v-for="fa in fileActions"
          :key="`${fa.pluginId}:${fa.action.id}`"
          class="ctx-item"
          @click="runPluginAction(fa.pluginId, fa.action.id)"
        >
          <Icon :name="fa.action.icon || 'puzzle'" :size="13" />
          <span class="ctx-item-label">{{ fa.action.label }}</span>
          <span class="ctx-item-src">{{ fa.pluginName }}</span>
        </button>
      </div>
    </div>

    <ConfirmDialog
      :open="confirmDel !== null"
      title="删除"
      :message="confirmDel ? `确定删除「${confirmDel.label}」？会移入系统回收站，可恢复。` : ''"
      :busy="deleting"
      :danger="true"
      :on-confirm="confirmDelete"
      :on-cancel="() => (confirmDel = null)"
    />
  </div>
</template>

<style scoped>
.files-view {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-6) var(--space-8);
}
.files-crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: var(--text-sm);
  overflow-x: auto;
  padding: 2px 0;
  margin-bottom: var(--space-3);
}
.crumb {
  background: none;
  border: none;
  color: var(--fg);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}
.crumb:hover {
  background: var(--bg-soft);
}
.crumb-sep {
  color: var(--fg-faint);
}
.files-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.files-sort-label {
  font-size: var(--text-xs);
  color: var(--fg-faint);
  margin-right: var(--space-1);
}
.sort-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 3px 10px;
  font-size: var(--text-xs);
  color: var(--fg-muted);
  cursor: pointer;
  transition:
    color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.sort-btn:hover {
  color: var(--fg);
  border-color: var(--border-strong);
}
.sort-btn.on {
  color: var(--accent);
  border-color: var(--accent);
}
.files-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  overflow: auto;
}
.files-list li {
  border-bottom: 1px solid var(--border);
}
.files-list li:last-child {
  border-bottom: none;
}
.files-list li.selected {
  background: var(--accent-soft);
}
.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 8px var(--space-4);
  background: none;
  border: none;
  color: var(--fg);
  cursor: pointer;
  text-align: left;
  font-size: var(--text-sm);
}
.file-row:hover {
  background: var(--bg-soft);
}
.file-row.dir .file-name {
  font-weight: 600;
}
.file-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  color: var(--fg-faint);
}
.files-list li.selected .file-check {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size {
  font-size: var(--text-xs);
  color: var(--fg-faint);
  min-width: 64px;
  text-align: right;
}
.file-time {
  font-size: var(--text-xs);
  color: var(--fg-faint);
  min-width: 64px;
  text-align: right;
}
.file-ops {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.file-row:hover .file-ops {
  opacity: 1;
}
.op {
  background: none;
  border: none;
  color: var(--fg-faint);
  cursor: pointer;
  padding: 3px 5px;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
}
.op:hover {
  background: var(--bg-soft);
  color: var(--fg);
}
.files-actionbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}
.actionbar-count {
  font-size: var(--text-sm);
  color: var(--fg-muted);
  margin-right: var(--space-1);
}
.btn.danger {
  color: var(--danger);
  border-color: var(--danger);
}
.batch-plugins {
  position: relative;
}
.batch-plugins-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  z-index: 80;
  min-width: 220px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-2);
  padding: 4px;
  margin-bottom: 4px;
}
.files-ctx {
  position: fixed;
  z-index: 100;
  min-width: 200px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-2);
  padding: 4px;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--fg);
  cursor: pointer;
  font-size: var(--text-sm);
  text-align: left;
}
.ctx-item:hover {
  background: var(--bg-soft);
}
.ctx-item.danger {
  color: var(--danger);
}
.ctx-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-item-src {
  font-size: var(--text-xs);
  color: var(--fg-faint);
}
.ctx-chevron {
  margin-left: auto;
  color: var(--fg-faint);
  font-size: 10px;
}
.ctx-sub {
  margin-top: 2px;
  padding-top: 2px;
  border-top: 1px solid var(--border);
}
</style>
