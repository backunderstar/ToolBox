<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * core-checklists 插件自带前端（组件模式）——Vue 3：清单列表 + 编辑器
 * （打卡/进度/笔记关联）。CSS 复用宿主全局样式（.checklist-* 等 class）。
 */
interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** 关联笔记（vault 相对路径） */
  note?: string;
}

/** 清单（data/checklists/<id>.json 的结构，与插件一致：camelCase） */
interface Checklist {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  items: ChecklistItem[];
}

/** 清单列表元信息（按 updatedAt 倒序） */
interface ChecklistMeta {
  id: string;
  title: string;
  done: number;
  total: number;
  updatedAt: string;
}

/** 跨插件 core-notes 文件条目（笔记选择器与断链检测的数据源） */
interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

const props = defineProps<{ api: PluginBridgeApi }>();

const vault = props.api.context.vault;

/* ---- 数据层状态 ---- */
const metas = ref<ChecklistMeta[]>([]);
const current = ref<Checklist | null>(null);
const loading = ref(false);

/* ---- 视图状态 ---- */
const newTitle = ref("");
const newItem = ref("");
const pickingNote = ref<string | null>(null);
const noteQuery = ref("");
const confirmDel = ref<{ id: string; title: string } | null>(null);
/** 跨插件文件列表（笔记选择器与断链检测的数据源） */
const notes = ref<FileEntry[]>([]);

/* ---- 自动保存（800ms 防抖，与宿主一致） ---- */
const AUTOSAVE = 800;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 待保存快照：调度时捕获，避免切换清单/工作区后写错对象 */
let pending: Checklist | null = null;

/* ---- 数据层：读 ---- */

async function refresh(): Promise<void> {
  if (!vault) {
    metas.value = [];
    return;
  }
  loading.value = true;
  try {
    const all = (await props.api.call("chk.list")) as Checklist[];
    metas.value = all
      .map((c) => ({
        id: c.id,
        title: c.title,
        done: c.items.filter((i) => i.done).length,
        total: c.items.length,
        updatedAt: c.updatedAt,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  } catch (e) {
    console.error("[checklists] 刷新失败", e);
  } finally {
    loading.value = false;
  }
}

/** 跨插件取笔记文件列表（等价宿主 vault.files） */
async function loadNotes(): Promise<void> {
  if (!vault) {
    notes.value = [];
    return;
  }
  try {
    notes.value = (await props.api.call("notes.list", {}, "core-notes")) as FileEntry[];
  } catch (e) {
    console.error("[checklists] 读取笔记列表失败", e);
  }
}

/* ---- 数据层：写（mutate 模式 + 防抖保存） ---- */

/** 写入：插件统一刷新 updatedAt，返回更新后的清单 */
async function persist(list: Checklist): Promise<Checklist | null> {
  if (!vault) return null;
  return (await props.api.call("chk.save", { checklist: list })) as Checklist;
}

async function save(list?: Checklist): Promise<void> {
  const snapshot = list ?? pending ?? current.value;
  if (!snapshot) return;
  pending = null;
  const updated = { ...snapshot, updatedAt: new Date().toISOString() };
  try {
    const saved = await persist(updated);
    // 保存期间产生了新的本地编辑（pending 已重新置位）：保留本地未保存内容，
    // 避免服务端返回的旧快照覆盖正在输入的状态
    if (!pending) {
      // 仅当当前仍显示该清单时同步 UI（其余场景由后续刷新兜底）
      if (saved && current.value && current.value.id === saved.id) {
        current.value = { ...saved };
      }
    }
    await refresh();
  } catch (e) {
    console.error("[checklists] 保存失败", e);
    // 保留待保存快照，供重试
    pending = snapshot;
  }
}

/** 立即冲洗待保存编辑（切换清单前调用，避免定时器触发时写错对象） */
function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const s = pending;
  if (s) void save(s);
}

function scheduleSave(snapshot: Checklist): void {
  pending = snapshot;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = pending;
    pending = null;
    if (s) void save(s);
  }, AUTOSAVE);
}

/** 变更：基于最新已提交状态计算 next，副作用（调度保存）独立 */
function mutate(fn: (c: Checklist) => Checklist): void {
  const cur = current.value;
  if (!cur) return;
  const next = fn(cur);
  current.value = next;
  scheduleSave(next);
}

/* ---- 数据层：CRUD ---- */

async function open(id: string): Promise<void> {
  // 切换前冲洗当前清单的待保存编辑，避免定时器触发时写错对象
  flush();
  if (!vault) return;
  try {
    const c = (await props.api.call("chk.get", { id })) as Checklist | null;
    // 取数期间产生了新的本地编辑（chk-changed 事件驱动重取场景）：保留本地未保存内容
    if (pending || saveTimer) return;
    current.value = c;
  } catch (e) {
    console.error(`[checklists] 打开失败 ${id}`, e);
  }
}

/* ---- 宿主反链跳转：tb:open-checklist 事件 + 挂载期标记 ---- */
onMounted(() => {
  const handle = (e: Event) => {
    const id = (e as CustomEvent<string>).detail;
    if (id) void open(id);
  };
  window.addEventListener("tb:open-checklist", handle);
  // 挂载期标记：视图切换是异步的，本组件可能晚于标记写入才挂载
  const pendingMark = (window as unknown as Record<string, unknown>).__TB_PENDING_CHECKLIST__;
  if (typeof pendingMark === "string" && pendingMark) {
    delete (window as unknown as Record<string, unknown>).__TB_PENDING_CHECKLIST__;
    void open(pendingMark);
  }
  onBeforeUnmount(() => window.removeEventListener("tb:open-checklist", handle));
});

async function create(title: string): Promise<void> {
  const t = title.trim();
  if (!t || !vault) return;
  try {
    // 插件负责 id 生成与同名冲突加序号
    const r = (await props.api.call("chk.create", { title: t })) as Checklist;
    await refresh();
    await open(r.id);
  } catch (e) {
    console.error(`[checklists] 创建失败 ${t}`, e);
  }
}

async function remove(id: string): Promise<void> {
  if (!vault) return;
  try {
    await props.api.call("chk.delete", { id });
  } catch (e) {
    console.error(`[checklists] 删除失败 ${id}`, e);
  }
  if (current.value?.id === id) current.value = null;
  await refresh();
}

function rename(title: string): void {
  const t = title.trim();
  if (!t) return;
  mutate((c) => ({ ...c, title: t }));
}

function addItem(text: string): void {
  const t = text.trim();
  if (!t) return;
  mutate((c) => ({
    ...c,
    items: [
      ...c.items,
      {
        id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        text: t,
        done: false,
      },
    ],
  }));
}

function toggleItem(id: string): void {
  mutate((c) => ({
    ...c,
    items: c.items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)),
  }));
}

function removeItem(id: string): void {
  mutate((c) => ({ ...c, items: c.items.filter((i) => i.id !== id) }));
}

function updateItem(id: string, text: string): void {
  mutate((c) => ({
    ...c,
    items: c.items.map((i) => (i.id === id ? { ...i, text } : i)),
  }));
}

function setItemNote(id: string, note: string | undefined): void {
  mutate((c) => ({
    ...c,
    items: c.items.map((i) => (i.id === id ? { ...i, note: note || undefined } : i)),
  }));
}

/* ---- 效果 ---- */

/* 首次挂载刷新（插件视图随工作区切换整体重挂载，api 即最新上下文） */
onMounted(() => {
  void refresh();
  void loadNotes();
});

/* 写操作后插件推送 chk-changed：刷新 metas；当前清单无本地编辑时重取（多窗口一致） */
let unChanged: (() => void) | null = null;
onMounted(() => {
  unChanged = props.api.on("chk-changed", () => {
    void refresh();
    void loadNotes();
    // 有未保存编辑时跳过重取，避免覆盖正在输入的内容
    if (current.value && !pending && !saveTimer) {
      void open(current.value.id);
    }
  });
});

/* 卸载时冲洗待保存编辑：宿主应用级常驻不会卸载，插件视图切换即卸载，
   防抖窗口内的编辑会丢，这里补一次 flush */
onBeforeUnmount(() => {
  unChanged?.();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const s = pending;
  pending = null;
  if (s && vault) {
    void props.api
      .call("chk.save", {
        checklist: { ...s, updatedAt: new Date().toISOString() },
      })
      .catch((e) => console.error("[checklists] 卸载保存失败", e));
  }
});

/* 点击外部关闭笔记选择器 */
onMounted(() => {
  const onDoc = (e: MouseEvent) => {
    const t = e.target as Node | null;
    if (t && !document.querySelector(".note-picker")?.contains(t)) {
      pickingNote.value = null;
    }
  };
  document.addEventListener("mousedown", onDoc);
  onBeforeUnmount(() => document.removeEventListener("mousedown", onDoc));
});

/* ---- 视图逻辑 ---- */

async function submitCreate(): Promise<void> {
  if (!newTitle.value.trim()) return;
  await create(newTitle.value);
  newTitle.value = "";
}

function submitItem(): void {
  if (!newItem.value.trim()) return;
  addItem(newItem.value);
  newItem.value = "";
}

function pickNote(itemId: string, note: string): void {
  setItemNote(itemId, note);
  pickingNote.value = null;
  noteQuery.value = "";
}

/* 笔记选择器列表：Markdown 文件 */
const mdNotes = computed(() =>
  notes.value.filter((f) => !f.isDir && f.path.toLowerCase().endsWith(".md")),
);

const done = computed(() => current.value?.items.filter((i) => i.done).length ?? 0);
const total = computed(() => current.value?.items.length ?? 0);
const pct = computed(() =>
  total.value > 0 ? Math.round((done.value / total.value) * 100) : 0,
);

function rowKeyDown(e: KeyboardEvent, activate: () => void): void {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    activate();
  }
}

const filteredNotes = computed(() =>
  mdNotes.value.filter((n) =>
    n.path.toLowerCase().includes(noteQuery.value.toLowerCase()),
  ),
);

function noteExists(path: string): boolean {
  return notes.value.some((f) => f.path === path);
}
</script>

<template>
  <div class="checklist-view">
    <template v-if="!vault">
      <div class="empty-state">
        <h2>清单</h2>
        <p>请先在顶栏选择一个工作区，再使用清单</p>
      </div>
    </template>
    <template v-else>
      <!-- 左：清单列表 -->
      <aside class="checklist-pane">
        <div class="checklist-pane-head">
          <span class="checklist-pane-title">清单</span>
          <span class="checklist-count">{{ metas.length }}</span>
        </div>
        <div class="checklist-new">
          <input
            class="checklist-new-input"
            v-model="newTitle"
            @keydown.enter="submitCreate"
            placeholder="新建清单…"
          />
          <button class="icon-btn sm" @click="submitCreate" title="新建清单">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div class="checklist-list">
          <div v-if="metas.length === 0 && !loading" class="tree-empty">
            <p>还没有清单</p>
            <p class="tree-empty-hint">在上方输入名称创建</p>
          </div>
          <div
            v-for="m in metas"
            :key="m.id"
            class="checklist-row"
            :class="{ active: current?.id === m.id }"
            role="button"
            tabindex="0"
            :aria-current="current?.id === m.id ? 'true' : undefined"
            @click="open(m.id)"
            @keydown="rowKeyDown($event, () => open(m.id))"
          >
            <div class="checklist-row-main">
              <span class="checklist-row-title">{{ m.title }}</span>
              <span class="checklist-row-progress">{{ m.done }}/{{ m.total }}</span>
            </div>
            <div class="checklist-row-actions">
              <button
                class="tree-action danger"
                title="删除清单"
                :aria-label="`删除清单 ${m.title}`"
                @click.stop="confirmDel = { id: m.id, title: m.title }"
              >
                <svg
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
            </div>
          </div>
        </div>
      </aside>

      <!-- 右：清单编辑器 -->
      <section class="checklist-main" aria-label="清单编辑器">
        <div v-if="!current" class="empty-state">
          <h2>清单</h2>
          <p>选择一个清单开始打卡，或新建一个清单</p>
        </div>
        <div v-else class="checklist-editor">
          <div class="checklist-editor-head">
            <input
              class="checklist-title-input"
              :value="current.title"
              @input="rename(($event.target as HTMLInputElement).value)"
              spellcheck="false"
            />
            <button class="btn btn-sm" @click="refresh">刷新</button>
          </div>

          <div class="checklist-progress">
            <div class="checklist-progress-track">
              <div class="checklist-progress-fill" :style="{ width: `${pct}%` }" />
            </div>
            <span class="checklist-progress-text">{{ done }}/{{ total }} · {{ pct }}%</span>
          </div>

          <ul class="checklist-items">
            <li
              v-for="item in current.items"
              :key="item.id"
              class="checklist-item"
              :class="{ done: item.done }"
            >
              <label class="checklist-check">
                <input type="checkbox" :checked="item.done" @change="toggleItem(item.id)" />
              </label>
              <input
                class="checklist-item-text"
                :value="item.text"
                @input="updateItem(item.id, ($event.target as HTMLInputElement).value)"
                spellcheck="false"
              />
              <span class="checklist-item-note">
                <button
                  v-if="item.note"
                  class="note-link"
                  :class="{ broken: !noteExists(item.note) }"
                  @click="api.nav?.openNote(item.note!)"
                  :title="
                    noteExists(item.note) ? `打开 ${item.note}` : `${item.note}（笔记不存在）`
                  "
                >
                  <svg
                    width="12"
                    height="12"
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
                  {{ item.note.split("/").pop() }}
                </button>
                <span class="note-pick-wrap">
                  <button
                    class="note-pick"
                    @click="pickingNote = pickingNote === item.id ? null : item.id"
                    title="关联笔记"
                    aria-label="关联笔记"
                    :aria-expanded="pickingNote === item.id"
                  >
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <div v-if="pickingNote === item.id" class="note-picker">
                    <input
                      class="note-picker-input"
                      v-model="noteQuery"
                      placeholder="搜索笔记…"
                    />
                    <div class="note-picker-list">
                      <button
                        v-for="n in filteredNotes"
                        :key="n.path"
                        class="note-picker-item"
                        @click="pickNote(item.id, n.path)"
                      >
                        {{ n.path }}
                      </button>
                      <div v-if="mdNotes.length === 0" class="note-picker-empty">
                        工作区没有 Markdown 笔记
                      </div>
                    </div>
                  </div>
                </span>
              </span>
              <button
                class="tree-action danger"
                title="删除条目"
                @click="removeItem(item.id)"
              >
                <svg
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
            </li>
            <li v-if="current.items.length === 0" class="checklist-empty">添加第一个条目</li>
          </ul>

          <div class="checklist-add">
            <input
              class="checklist-new-input"
              v-model="newItem"
              @keydown.enter="submitItem"
              placeholder="添加条目，回车确认…"
            />
            <button class="btn btn-sm" @click="submitItem">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              添加
            </button>
          </div>
        </div>
      </section>
    </template>

    <!-- 删除确认 -->
    <div v-if="confirmDel" class="confirm-overlay" @click="confirmDel = null">
      <div class="confirm-dialog" @click.stop>
        <h3 class="confirm-title">删除清单</h3>
        <p class="confirm-message">确定删除清单「{{ confirmDel.title }}」？此操作不可撤销。</p>
        <div class="confirm-actions">
          <button class="btn" @click="confirmDel = null">取消</button>
          <button
            class="btn btn-danger"
            @click="
              () => {
                void remove(confirmDel.id);
                confirmDel = null;
              }
            "
          >
            删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
