<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PluginBridgeApi, SearchHit, FileEntry } from "./bridge";
import FileTree from "./FileTree.vue";
import BacklinksPanel from "./BacklinksPanel.vue";
import SearchResults from "./SearchResults.vue";
import NoteEditor from "./NoteEditor.vue";
import "./style.css";

/**
 * core-notes 插件自带前端（组件模式）——Vue 3：文件树 + 编辑器 + 反链 + 全文搜索。
 * 数据全部经统一 api 桥：本插件命令（notes.*）+ 宿主内嵌搜索（api.host.search）/
 * 跨插件（core-checklists 反链 / core-ai 摘要）。宿主全局 CSS 生效，
 * 仅新增少量样式在 style.css（Vite 提取，宿主注入）。
 * 编辑器：md-editor-v3（Vue 3 生态），见 NoteEditor.vue。
 */
interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  note?: string;
}
interface Checklist {
  id: string;
  title: string;
  items: ChecklistItem[];
}

const AUTOSAVE = 800;
const SEARCH_DELAY = 300;

const props = defineProps<{ api: PluginBridgeApi }>();

const vault = props.api.context.vault;

const files = ref<FileEntry[]>([]);
const activePath = ref<string | null>(null);
const content = ref("");
const dirty = ref(false);
const query = ref("");
const results = ref<SearchHit[] | null>(null);
const searching = ref(false);
// 状态消息条：flash() 写入，4s 后自动清除；err=true 渲染为错误样式（编辑器底部 .editor-status）
const status = ref("");
const statusErr = ref(false);
/* 布局偏好：文件面板折叠 / 专注模式（localStorage 持久化，宿主布局互不影响） */
const filesCollapsed = ref(loadPref("notes.filesCollapsed", false));
const focusMode = ref(loadPref("notes.focusMode", false));
const dark = ref(document.documentElement.dataset.theme === "dark");

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

/** 状态条消息：新消息重置 4s 清除计时（连发时以最后一条为准） */
function flash(msg: string, err = false): void {
  status.value = msg;
  statusErr.value = err;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.value = ""), 4000);
}

/* 主题跟随：宿主切换主题时更新（md-editor-v3 theme + 暗色变量由宿主 tokens 自动生效） */
onMounted(() => {
  const mo = new MutationObserver(() => {
    dark.value = document.documentElement.dataset.theme === "dark";
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  onBeforeUnmount(() => mo.disconnect());
});

/* 卸载时清理状态条计时器 */
onBeforeUnmount(() => {
  if (statusTimer) clearTimeout(statusTimer);
});

watch(filesCollapsed, (v) => savePref("notes.filesCollapsed", v));
watch(focusMode, (v) => savePref("notes.focusMode", v));

async function refresh(): Promise<void> {
  if (!vault) return;
  try {
    files.value = (await props.api.call("notes.list")) as FileEntry[];
  } catch (e) {
    flash(String(e), true);
  }
}

async function save(manual = false): Promise<void> {
  const ap = activePath.value;
  const c = content.value;
  if (!vault || !ap) return;
  try {
    await props.api.call("notes.write", { rel: ap, content: c });
    const latest = content.value;
    if (latest === c) {
      dirty.value = false;
      if (manual) flash(`已保存 ${ap}`);
    } else if (manual) {
      flash("保存中检测到新输入，稍后自动保存");
    }
  } catch (e) {
    flash(String(e), true);
  }
}

async function openFile(rel: string): Promise<void> {
  if (!vault) return;
  if (dirty.value) await save(false);
  // 快照打开前的内容：读盘是异步 IPC，若期间用户继续输入，
  // 直接覆盖会用旧内容覆盖新输入 → 静默丢字
  const before = content.value;
  try {
    const text = (await props.api.call("notes.read", { rel })) as string;
    if (content.value !== before) {
      flash("读取期间有新的输入，已取消切换");
      return;
    }
    activePath.value = rel;
    content.value = text;
    dirty.value = false;
    // 同步宿主 vault（tb:vault-active）：AI 预设等插件界面经 context 读取当前笔记
    window.dispatchEvent(
      new CustomEvent("tb:vault-active", { detail: { rel, content: text } }),
    );
  } catch (e) {
    flash(String(e), true);
  }
}

async function newNote(): Promise<void> {
  if (!vault) return;
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rel = `notes/笔记-${ts}.md`;
  try {
    await props.api.call("notes.create", { rel });
    await refresh();
    await openFile(rel);
  } catch (e) {
    flash(String(e), true);
  }
}

async function removeFile(rel: string): Promise<void> {
  if (!vault) return;
  try {
    await props.api.call("notes.delete", { rel });
    await refresh();
    if (activePath.value === rel) {
      activePath.value = null;
      content.value = "";
      dirty.value = false;
    }
    flash(`已删除 ${rel}`);
  } catch (e) {
    flash(String(e), true);
  }
}

async function renameFile(from: string, to: string): Promise<void> {
  if (!vault || from === to) return;
  // 前端校验（后端也会兜底）：非法字符 / 目标已存在
  const name = to.slice(to.lastIndexOf("/") + 1);
  if (/[\\/:*?"<>|]/.test(name)) {
    flash(`文件名包含非法字符: ${name}`, true);
    return;
  }
  if (files.value.some((f) => f.path === to && f.path !== from)) {
    flash(`同名文件已存在: ${to}`, true);
    return;
  }
  try {
    await props.api.call("notes.rename", { from, to });
    await refresh();
    if (activePath.value === from) activePath.value = to;
    flash(`已重命名 ${from} → ${to}`);
  } catch (e) {
    flash(String(e), true);
  }
}

function updateContent(text: string): void {
  content.value = text;
  dirty.value = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(false), AUTOSAVE);
}

/* 卸载兜底：自动保存定时器未触发时把草稿落盘 */
onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
  if (dirty.value) void save(false);
});

/* 启动：加载文件列表 */
onMounted(() => {
  if (!vault) return;
  void refresh();
});

/* 挂载时打开目标笔记：优先其他视图经 tb:open-note 广播的待打开笔记，
   否则回退宿主 context 快照（双向链接/跨视图跳转进入本视图的场景） */
onMounted(() => {
  if (!vault) return;
  const w = window as unknown as Record<string, unknown>;
  const pending = typeof w.__TB_PENDING_NOTE__ === "string" ? (w.__TB_PENDING_NOTE__ as string) : null;
  if (pending) {
    w.__TB_PENDING_NOTE__ = null;
    void openFile(pending);
  } else if (typeof props.api.context.activePath === "string" && props.api.context.activePath) {
    void openFile(props.api.context.activePath);
  }
});

/* tb:open-note 事件（安全网：本视图已挂载时其他界面打开笔记） */
onMounted(() => {
  const onOpen = (e: Event) => {
    const rel = (e as CustomEvent<string>).detail;
    if (typeof rel === "string" && rel) void openFile(rel);
  };
  window.addEventListener("tb:open-note", onOpen);
  onBeforeUnmount(() => window.removeEventListener("tb:open-note", onOpen));
});

/* notes-changed：其他窗口/插件 UI 写文件后刷新文件列表 */
let unChanged: (() => void) | null = null;
onMounted(() => {
  unChanged = props.api.on("notes-changed", () => void refresh());
});
onBeforeUnmount(() => unChanged?.());

/* 全文搜索：防抖 + 序号丢弃过期响应（宿主内嵌搜索，经统一桥 host.search） */
watch(query, (q) => {
  if (!vault || !q.trim()) {
    searchSeq++;
    results.value = null;
    searching.value = false;
    return;
  }
  searching.value = true;
  if (searchTimer) clearTimeout(searchTimer);
  const seq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    try {
      const r = props.api.host ? await props.api.host.search(q) : [];
      if (seq !== searchSeq) return;
      results.value = r;
    } catch {
      if (seq === searchSeq) results.value = [];
    } finally {
      if (seq === searchSeq) searching.value = false;
    }
  }, SEARCH_DELAY);
});

/* 反链索引：跨插件取清单数据，按笔记路径建索引 */
const backlinks = ref<
  Map<string, { type: "清单"; id: string; title: string }[]>
>(new Map());
onMounted(() => {
  let alive = true;
  (async () => {
    const map = new Map<string, { type: "清单"; id: string; title: string }[]>();
    const push = (key: string, entry: { type: "清单"; id: string; title: string }) => {
      const k = key.replace(/^\/+/, "");
      if (!k) return;
      const list = map.get(k) ?? [];
      list.push(entry);
      map.set(k, list);
    };
    try {
      const chks = (await props.api.call("chk.list", {}, "core-checklists")) as Checklist[];
      for (const c of chks)
        for (const it of c.items)
          if (it.note) push(it.note, { type: "清单", id: c.id, title: c.title });
    } catch {
      /* 清单插件不可用则跳过 */
    }
    if (alive) backlinks.value = map;
  })();
  onBeforeUnmount(() => {
    alive = false;
  });
});

const vaultName = vault ? (vault.split(/[\\/]/).pop() ?? vault) : null;
const showingSearch = computed(() => query.value.trim().length > 0);

async function openHit(hit: SearchHit): Promise<void> {
  await openFile(hit.path);
  query.value = "";
}
</script>

<template>
  <!-- 无工作区：引导（选工作区按钮在宿主顶栏） -->
  <div v-if="!vault" class="empty-state fade-in">
    <div class="empty-icon">
      <svg
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
    </div>
    <h2>选择工作区文件夹</h2>
    <p>
      笔记以普通 Markdown 文件存放在你指定的文件夹中，
      数据始终是你的，随时可迁移、可备份。请在顶栏点击工作区按钮选择。
    </p>
  </div>
  <div v-else class="notes">
    <!-- 文件侧栏（专注模式或折叠时隐藏/收窄） -->
    <template v-if="!focusMode">
      <aside v-if="filesCollapsed" class="files-pane collapsed">
        <button
          class="files-expand"
          @click="filesCollapsed = false"
          title="展开文件面板"
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
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </aside>
      <aside v-else class="files-pane">
        <div class="files-header">
          <span class="files-title" :title="vault">{{ vaultName }}</span>
          <button class="icon-btn sm" title="新建笔记" aria-label="新建笔记" @click="newNote">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            class="icon-btn sm"
            title="收起文件面板"
            aria-label="收起文件面板"
            @click="filesCollapsed = true"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
        </div>
        <!-- 插件自带搜索框（顶栏搜索在插件模式下停用） -->
        <div class="files-search">
          <input
            class="files-search-input"
            type="text"
            v-model="query"
            placeholder="搜索笔记（文件名 + 内容）…"
            spellcheck="false"
          />
        </div>
        <FileTree
          :files="files"
          :active-path="activePath"
          :on-open="openFile"
          :on-remove="removeFile"
          :on-rename="renameFile"
        />
      </aside>
    </template>

    <!-- 编辑器区域 -->
    <div class="editor-area">
      <SearchResults
        v-if="showingSearch"
        :searching="searching"
        :results="results"
        :query="query"
        :on-open="openHit"
      />
      <template v-else-if="activePath">
        <div class="editor-header">
          <span
            class="dirty-dot"
            :class="{ on: dirty }"
            :title="dirty ? '有未保存修改' : '已保存'"
          />
          <span class="editor-title" :title="activePath">{{ activePath }}</span>
          <div class="spacer" />
          <button
            class="icon-btn sm"
            @click="focusMode = !focusMode"
            :title="focusMode ? '退出专注模式' : '专注模式（隐藏侧栏，全屏书写）'"
            :aria-label="focusMode ? '退出专注模式' : '专注模式'"
          >
            <svg
              v-if="!focusMode"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
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
              <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
            </svg>
          </button>
          <button class="btn-ghost sm" @click="save(true)">{{ dirty ? "保存" : "已保存" }}</button>
        </div>
        <BacklinksPanel :active-path="activePath" :backlinks="backlinks" :nav="api.nav" />
        <div class="editor-body">
          <NoteEditor
            :key="activePath"
            :api="api"
            :doc="content"
            :on-change="updateContent"
            :on-save="() => save(true)"
            :dark="dark"
            :on-flash="flash"
            placeholder-text="开始书写…"
          />
        </div>
      </template>
      <div v-else class="empty-state">
        <div class="empty-icon">
          <svg
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
        </div>
        <h2>从一篇笔记开始</h2>
        <p>在左侧选择一篇笔记，或新建一篇。</p>
        <button class="btn-primary" @click="newNote">新建笔记</button>
      </div>

      <!-- 操作反馈（flash 消息，4s 自动清除）：浮动在编辑器右下角 -->
      <div
        class="editor-status"
        :class="{ error: statusErr }"
        role="status"
        aria-live="polite"
      >
        {{ status }}
      </div>
    </div>
  </div>
</template>
