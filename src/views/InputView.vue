<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  inputDelete,
  inputImport,
  inputList,
  inputMkdir,
  inputOpen,
  inputRename,
  inputToWorkspace,
} from "../core/api";
import type { FileEntry } from "../core/api";
import { useVault } from "../core/vault";
import { askPrompt } from "../core/prompt";
import Icon from "../components/Icon.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";

/**
 * 文件输入（Inbox，数据根/Input）：
 * - 未知/待分类文件先放进这里（支持系统拖拽移入），后续再分类到各工作区；
 * - 各工作区/插件可**只读** Input（插件经 TB_INBOX / 浏览选待处理文件）；
 * - 本视图：列目录 / 拖拽导入 / 移入当前工作区（分类）/ 删除（回收站）/ 系统打开。
 */
const dir = ref(""); // Input 内相对目录（空 = 根）
const inputDir = ref(""); // 当前浏览的 Input 绝对目录（input_list 返回）
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const error = ref("");

const vault = useVault();
/** 当前工作区名（用于「移入当前工作区」确认/提示；未配置为空） */
const wsName = computed(() => vault.state.current ?? "");

/** 选择模式 + 已选（key = Input 相对路径） */
const selMode = ref(false);
const selected = ref<Set<string>>(new Set());

const confirmDel = ref<{ label: string; rels: string[] } | null>(null);
const deleting = ref(false);

/** 移入当前工作区的确认（移动是变更操作，先确认再执行） */
const confirmMove = ref<{ label: string; rels: string[] } | null>(null);
const moving = ref(false);

/** 拖拽进行中（用于高亮导入区） */
const dragActive = ref(false);

/** 操作结果提示（拖拽导入 / 归位 / 删除后短暂显示） */
const actionMsg = ref<string | null>(null);
let msgTimer: number | null = null;

const crumbs = computed(() => (dir.value ? dir.value.split("/") : []));

const sorted = computed(() => {
  const dirs = entries.value.filter((e) => e.isDir);
  const files = entries.value.filter((e) => !e.isDir);
  const cmp = (a: FileEntry, b: FileEntry) =>
    a.name.localeCompare(b.name, "zh");
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

/** 相对路径（含当前子目录前缀），供归位/删除/打开 */
function relOf(e: FileEntry): string {
  return dir.value ? `${dir.value}/${e.name}` : e.name;
}

function flash(msg: string): void {
  actionMsg.value = msg;
  if (msgTimer !== null) window.clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => (actionMsg.value = null), 4000);
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const r = await inputList(dir.value);
    inputDir.value = r.dir;
    entries.value = r.entries;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function toRoot(): void {
  dir.value = "";
  void reload();
}

function gotoCrumb(i: number): void {
  dir.value = crumbs.value.slice(0, i + 1).join("/");
  void reload();
}

function enterEntry(e: FileEntry): void {
  if (e.isDir) {
    dir.value = relOf(e);
    void reload();
  } else {
    void openEntry(e);
  }
}

async function openEntry(e: FileEntry): Promise<void> {
  try {
    await inputOpen(relOf(e));
  } catch (err) {
    error.value = `打开失败: ${err}`;
  }
}

async function openRoot(): Promise<void> {
  try {
    // 打开当前浏览目录（子目录时打开该子目录；无则 Input 根）
    await inputOpen(dir.value || undefined);
  } catch (err) {
    error.value = `打开失败: ${err}`;
  }
}

function toggleSelect(e: FileEntry): void {
  const rel = relOf(e);
  const s = new Set(selected.value);
  if (s.has(rel)) s.delete(rel);
  else s.add(rel);
  selected.value = s;
}

function clearSelection(): void {
  selected.value = new Set();
  selMode.value = false;
}

/** 在 Input 当前目录新建子文件夹（弹统一输入框取名） */
async function newFolder(): Promise<void> {
  const name = await askPrompt({
    title: "新建文件夹",
    message: `在「文件输入」${dir.value ? `/${dir.value}` : ""} 下新建：`,
    placeholder: "文件夹名",
    confirmText: "创建",
  });
  if (!name || !name.trim()) return;
  try {
    const mk = dir.value ? `${dir.value}/${name.trim()}` : name.trim();
    await inputMkdir(mk);
    flash(`已创建文件夹「${name.trim()}」`);
    void reload();
  } catch (e) {
    error.value = `新建失败: ${e}`;
  }
}

/** 重命名 Input 下某项（弹统一输入框） */
async function renameEntry(e: FileEntry): Promise<void> {
  const newName = await askPrompt({
    title: "重命名",
    message: `把「${e.name}」重命名为：`,
    placeholder: e.name,
    initial: e.name,
    confirmText: "重命名",
  });
  if (!newName || !newName.trim() || newName.trim() === e.name) return;
  try {
    const to = dir.value ? `${dir.value}/${newName.trim()}` : newName.trim();
    await inputRename(relOf(e), to);
    flash("已重命名");
    void reload();
  } catch (err) {
    error.value = `重命名失败: ${err}`;
  }
}

/** 移入当前工作区（分类归位）：先确认，再执行 */
function askMove(rels: string[], label: string): void {
  if (rels.length === 0) return;
  confirmMove.value = { label, rels };
}
async function confirmMoveFn(): Promise<void> {
  if (!confirmMove.value) return;
  moving.value = true;
  try {
    const r = await inputToWorkspace(confirmMove.value.rels);
    if (r.moved.length > 0) flash(`已移入当前工作区「${wsName.value || r.target}」${r.moved.length} 项`);
    if (r.errors.length > 0) error.value = `部分移入失败: ${r.errors.join("；")}`;
  } catch (e) {
    error.value = String(e);
  } finally {
    moving.value = false;
    confirmMove.value = null;
    clearSelection();
    void reload();
  }
}

function askDelete(rels: string[], label: string): void {
  confirmDel.value = { label, rels };
}

async function confirmDelete(): Promise<void> {
  if (!confirmDel.value) return;
  deleting.value = true;
  try {
    const r = await inputDelete(confirmDel.value.rels);
    if (r.deleted.length > 0) flash(`已移入回收站 ${r.deleted.length} 项`);
    if (r.errors.length > 0) error.value = `部分删除失败: ${r.errors.join("；")}`;
  } catch (e) {
    error.value = String(e);
  } finally {
    deleting.value = false;
    confirmDel.value = null;
    clearSelection();
    void reload();
  }
}

/* ---------- 拖拽导入（系统文件/文件夹移入 Input）--------- */
let dropUnlisten: (() => void) | null = null;
/** 组件已卸载：onDragDropEvent 的异步 unlisten 还未 resolve 时阻止注册后泄漏 */
let dropDisposed = false;
onMounted(() => {
  try {
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          dragActive.value = true;
        } else if (p.type === "leave") {
          dragActive.value = false;
        } else if (p.type === "drop") {
          dragActive.value = false;
          const paths = p.paths ?? [];
          if (paths.length > 0) void importDropped(paths);
        }
      })
      .then((un) => {
        if (dropDisposed) un();
        else dropUnlisten = un;
      })
      .catch(() => undefined);
  } catch {
    /* 浏览器 mock / 非 Tauri 环境忽略 */
  }
  void reload();
});
onBeforeUnmount(() => {
  dropDisposed = true;
  dropUnlisten?.();
  dropUnlisten = null;
  if (msgTimer !== null) window.clearTimeout(msgTimer);
});

async function importDropped(paths: string[]): Promise<void> {
  try {
    const r = await inputImport(paths);
    if (r.imported.length > 0) flash(`已导入 ${r.imported.length} 项到文件输入`);
    if (r.errors.length > 0) error.value = `部分导入失败: ${r.errors.join("；")}`;
    dir.value = ""; // 导入落 Input 根，回到根查看
    void reload();
  } catch (e) {
    error.value = `导入失败: ${e}`;
  }
}
</script>

<template>
  <div class="input-view" :class="{ dragging: dragActive }">
    <header class="view-header">
      <div>
        <h1>文件输入</h1>
        <p class="view-sub">数据根目录下的暂存区，未知/待分类文件先放这里，再分类到各工作区；也支持拖拽移入</p>
      </div>
      <div class="view-actions">
        <button class="btn" @click="newFolder" title="在文件输入里新建子文件夹" :disabled="!inputDir">
          <Icon name="plus" :size="13" /> 新建文件夹
        </button>
        <button class="btn" @click="openRoot" title="在资源管理器中打开文件输入目录" :disabled="!inputDir">
          <Icon name="folder" :size="13" /> 打开目录
        </button>
        <button class="btn" :class="{ on: selMode }" @click="selMode = !selMode" :disabled="entries.length === 0">
          选择
        </button>
        <button class="btn" @click="toRoot" :disabled="!dir">根</button>
        <button class="btn" @click="reload" :disabled="loading">刷新</button>
      </div>
    </header>

    <nav v-if="crumbs.length > 0" class="input-crumbs">
      <button class="crumb" @click="toRoot">文件输入</button>
      <template v-for="(c, i) in crumbs" :key="i">
        <span class="crumb-sep">/</span>
        <button class="crumb" @click="gotoCrumb(i)">{{ c }}</button>
      </template>
    </nav>

    <p v-if="actionMsg" class="input-actionbar" role="status">{{ actionMsg }}</p>
    <p v-if="error" class="module-empty warn">{{ error }}</p>
    <p v-else-if="loading" class="module-empty">加载中…</p>
    <p v-else-if="!dragActive && sorted.length === 0" class="module-empty">
      空目录——把未知/待分类的文件拖到这里，再从前面的插件处理
    </p>

    <!-- 拖拽导入区：dragging 时高亮 -->
    <div v-if="dragActive" class="drop-hint">松开鼠标，将文件移入「文件输入」</div>

    <ul v-else-if="sorted.length > 0" class="input-list">
      <li v-for="e in sorted" :key="relOf(e)" :class="{ selected: selected.has(relOf(e)) }">
        <button class="file-row" :class="{ dir: e.isDir }" @click="enterEntry(e)" :title="e.name">
          <span v-if="selMode" class="file-check" @click.stop="toggleSelect(e)">
            <Icon :name="selected.has(relOf(e)) ? 'check' : 'plus'" :size="13" />
          </span>
          <Icon :name="e.isDir ? 'folder' : 'file-text'" :size="14" />
          <span class="file-name">{{ e.name }}</span>
          <span v-if="!e.isDir && e.size != null" class="file-size">{{ fmtSize(e.size) }}</span>
          <span class="file-time">{{ fmtRelTime(e.mtime) }}</span>
          <span class="file-ops" @click.stop>
            <button class="op" title="打开（文件夹在资源管理器中打开）" @click="openEntry(e)">
              <Icon :name="e.isDir ? 'folder' : 'file-text'" :size="12" />
            </button>
            <button class="op" title="重命名" @click="renameEntry(e)">
              <Icon name="refresh" :size="12" />
            </button>
            <button class="op" title="移入当前工作区（分类）" @click="askMove([relOf(e)], e.name)">
              <Icon name="plus" :size="12" />
            </button>
            <button class="op" title="删除（回收站）" @click="askDelete([relOf(e)], e.name)">
              <Icon name="trash" :size="12" />
            </button>
          </span>
        </button>
      </li>
    </ul>

    <!-- 批量操作条 -->
    <div v-if="selected.size > 0" class="files-actionbar">
      <span class="actionbar-count">已选 {{ selected.size }} 项</span>
      <button class="btn" @click="askMove([...selected], `${selected.size} 项`)">移入当前工作区</button>
      <button class="btn danger" @click="askDelete([...selected], `${selected.size} 项`)">删除</button>
      <button class="btn" @click="clearSelection">取消</button>
    </div>

    <ConfirmDialog
      :open="confirmMove !== null"
      title="移入当前工作区"
      :message="confirmMove ? `确定把「${confirmMove.label}」移入当前工作区「${wsName || '未命名'}」？分类归位后将从文件输入移除。` : ''"
      :busy="moving"
      :on-confirm="confirmMoveFn"
      :on-cancel="() => (confirmMove = null)"
    />

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
.input-view {
  height: 100%;
  overflow-y: auto;
  padding: var(--space-6) var(--space-8);
}
.input-crumbs {
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
}
.crumb:hover {
  background: var(--bg-soft);
}
.crumb-sep {
  color: var(--fg-muted);
}
.input-actionbar {
  margin: 0 0 var(--space-3);
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  color: var(--fg);
  font-size: var(--text-sm);
}
.drop-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  margin-top: var(--space-4);
  border: 2px dashed var(--accent);
  border-radius: var(--radius-lg);
  color: var(--accent);
  font-size: var(--text-md);
  font-weight: 600;
  padding: var(--space-8);
}
/* 拖拽进行中：整个视图加个虚线描边提示落点 */
.input-view.dragging {
  border: 2px dashed var(--accent);
  border-radius: var(--radius-lg);
}
.input-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.file-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  color: var(--fg);
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-md);
}
.file-row:hover {
  background: var(--bg-soft);
}
.file-row.dir {
  font-weight: 600;
}
.file-check {
  display: inline-flex;
  flex: none;
  color: var(--fg-muted);
}
.file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  flex: none;
  min-width: 60px;
  text-align: right;
}
.file-time {
  color: var(--fg-muted);
  font-size: var(--text-xs);
  flex: none;
  min-width: 70px;
  text-align: right;
}
.file-ops {
  display: inline-flex;
  gap: 2px;
  flex: none;
  opacity: 0;
}
.file-row:hover .file-ops,
li.selected .file-ops {
  opacity: 1;
}
.op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.op:hover {
  color: var(--fg);
  background: var(--bg-elevated);
}
li.selected {
  background: var(--bg-soft);
}
/* 复用全局 files 批量操作条样式 */
.btn.danger {
  color: var(--danger);
  border-color: var(--danger);
}
.btn.danger:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--bg-soft);
}
.module-empty.warn {
  color: var(--danger);
}
.files-actionbar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}
.actionbar-count {
  font-size: var(--text-sm);
  color: var(--fg-muted);
  margin-right: auto;
}
</style>
