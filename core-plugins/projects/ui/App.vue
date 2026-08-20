<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * core-projects 插件自带前端（组件模式）——Vue 3：列表 + 详情（文件浏览器）。
 * CSS 复用宿主全局样式（.projects-* 等 class 在宿主 shell.css）。
 */
interface ProjectInfo {
  name: string;
  archived: boolean;
  fileCount: number;
}

interface ProjectFile {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

const props = defineProps<{ api: PluginBridgeApi }>();

const vault = props.api.context.vault;
const projects = ref<ProjectInfo[]>([]);
const loading = ref(false);
const current = ref<string | null>(null);
const cwd = ref("");
const files = ref<ProjectFile[] | null>(null);
const fileLoading = ref(false);
const notice = ref<string | null>(null);
const newName = ref("");
const confirmDel = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function flash(msg: string): void {
  notice.value = msg;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 2500);
}

/* 卸载时清理 notice 定时器，避免卸载后仍更新 */
onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer);
});

async function refresh(): Promise<void> {
  if (!vault) {
    projects.value = [];
    return;
  }
  loading.value = true;
  try {
    projects.value = (await props.api.call("projects.list")) as ProjectInfo[];
  } catch (e) {
    flash(String(e));
  } finally {
    loading.value = false;
  }
}

onMounted(() => void refresh());

async function loadFiles(proj: string, dir: string): Promise<void> {
  if (!vault || !proj) {
    files.value = null;
    return;
  }
  fileLoading.value = true;
  try {
    files.value = (await props.api.call("projects.files", { name: proj, dir })) as ProjectFile[];
  } catch (e) {
    files.value = null;
    flash(String(e));
  } finally {
    fileLoading.value = false;
  }
}

watch([current, cwd], () => void loadFiles(current.value ?? "", cwd.value));

async function create(): Promise<void> {
  const name = newName.value.trim();
  if (!name || !vault) return;
  try {
    await props.api.call("projects.create", { name });
    newName.value = "";
    await refresh();
    flash(`已创建项目 ${name}`);
  } catch (e) {
    flash(String(e));
  }
}

async function archive(name: string): Promise<void> {
  try {
    await props.api.call("projects.archive", { name });
    if (current.value === name) {
      current.value = null;
      cwd.value = "";
    }
    await refresh();
    flash(`已归档 ${name}`);
  } catch (e) {
    flash(String(e));
  }
}

async function unarchive(name: string): Promise<void> {
  try {
    await props.api.call("projects.unarchive", { name });
    await refresh();
    flash(`已还原 ${name}`);
  } catch (e) {
    flash(String(e));
  }
}

async function remove(name: string): Promise<void> {
  try {
    await props.api.call("projects.delete", { name });
    if (current.value === name) {
      current.value = null;
      cwd.value = "";
    }
    await refresh();
    flash(`已删除 ${name}`);
  } catch (e) {
    flash(String(e));
  }
}

async function openFile(rel: string): Promise<void> {
  if (!current.value) return;
  try {
    await props.api.call("projects.open", { name: current.value, rel });
    flash(`已用默认应用打开 ${rel.split("/").pop()}`);
  } catch (e) {
    flash(String(e));
  }
}

async function openFolder(rel: string): Promise<void> {
  if (!current.value) return;
  try {
    await props.api.call("projects.open", { name: current.value, rel });
    flash(`已打开文件夹 ${rel || "(项目根)"}`);
  } catch (e) {
    flash(String(e));
  }
}

function backDir(): void {
  const idx = cwd.value.lastIndexOf("/");
  cwd.value = idx === -1 ? "" : cwd.value.slice(0, idx);
}

/* 快捷键：Backspace 返回上级（输入框内不触发） */
onMounted(() => {
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Backspace" && current.value && cwd.value) {
      e.preventDefault();
      backDir();
    }
  };
  window.addEventListener("keydown", onKey);
  onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
});

const active = computed(() => projects.value.filter((x) => !x.archived));
const archived = computed(() => projects.value.filter((x) => x.archived));
const crumbs = computed(() => (cwd.value ? cwd.value.split("/") : []));

function goDetail(name: string): void {
  current.value = name;
  cwd.value = "";
  files.value = null;
}

function formatSize(n: number | null): string {
  if (n === null || n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
</script>

<template>
  <div class="projects-view">
    <header class="view-header">
      <div>
        <h1>项目</h1>
        <p class="view-sub">管理项目文件 —— 归档、浏览，点击用默认应用打开</p>
      </div>
      <div class="view-actions">
        <button class="btn" @click="refresh" :disabled="loading">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" />
          </svg>
          {{ loading ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </header>

    <div v-if="notice" class="projects-notice">{{ notice }}</div>

    <template v-if="!vault">
      <div class="empty-state">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
        </svg>
        <p>请先在顶栏选择一个工作区，再管理项目</p>
      </div>
    </template>
    <template v-else-if="current === null">
      <!-- 列表页 -->
      <div class="projects-new">
        <input
          class="projects-new-input"
          v-model="newName"
          @keydown.enter="create"
          placeholder="输入项目名称，回车创建（文件夹位于工作区 projects/ 下）"
          spellcheck="false"
        />
        <button class="btn btn-primary" @click="create" :disabled="!newName.trim()">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建项目
        </button>
      </div>

      <section class="projects-section">
        <h2 class="section-title">进行中（{{ active.length }}）</h2>
        <div v-if="active.length === 0" class="tool-result empty">
          还没有项目 —— 新建一个，或把已有文件夹放进工作区 projects/ 目录
        </div>
        <div v-else class="project-list">
          <div v-for="it in active" :key="it.name" class="project-card">
            <button class="project-card-main" @click="goDetail(it.name)" :title="`打开项目 ${it.name}`">
              <svg
                class="module-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
              </svg>
              <span class="project-card-name">{{ it.name }}</span>
              <span class="project-card-meta">{{ it.fileCount }} 个文件</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
            <div class="project-card-actions">
              <button class="btn btn-sm" @click="archive(it.name)">归档</button>
              <button class="btn btn-sm danger" @click="confirmDel = it.name">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                删除
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="projects-section">
        <h2 class="section-title">已归档（{{ archived.length }}）</h2>
        <div v-if="archived.length === 0" class="tool-result empty">归档的项目会出现在这里</div>
        <div v-else class="project-list">
          <div v-for="it in archived" :key="it.name" class="project-card">
            <button class="project-card-main" @click="goDetail(it.name)" :title="`打开项目 ${it.name}`">
              <svg
                class="module-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
              </svg>
              <span class="project-card-name">{{ it.name }}</span>
              <span class="project-card-meta">{{ it.fileCount }} 个文件</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
            <div class="project-card-actions">
              <button class="btn btn-sm" @click="unarchive(it.name)">还原</button>
              <button class="btn btn-sm danger" @click="confirmDel = it.name">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                删除
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 删除确认 -->
      <div v-if="confirmDel" class="confirm-overlay" @click="confirmDel = null">
        <div class="confirm-dialog" @click.stop>
          <h3 class="confirm-title">删除项目</h3>
          <p class="confirm-message">确定删除项目「{{ confirmDel }}」？将移入系统回收站。</p>
          <div class="confirm-actions">
            <button class="btn" @click="confirmDel = null">取消</button>
            <button
              class="btn btn-danger"
              @click="
                () => {
                  void remove(confirmDel);
                  confirmDel = null;
                }
              "
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </template>
    <template v-else>
      <!-- 详情页（文件浏览器） -->
      <div class="project-detail">
        <div class="project-detail-head">
          <button
            class="btn btn-sm"
            @click="
              () => {
                current = null;
                cwd = '';
                files = null;
              }
            "
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            全部项目
          </button>
          <h2 class="project-detail-title">{{ current }}</h2>
          <span class="project-detail-path">工作区/projects/{{ current }}</span>
        </div>

        <div class="project-crumbs">
          <button class="crumb" @click="cwd = ''">{{ current }}</button>
          <span v-for="(c, i) in crumbs" :key="c" class="crumb-seg">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
            <button class="crumb" @click="cwd = crumbs.slice(0, i + 1).join('/')">{{ c }}</button>
          </span>
        </div>

        <div v-if="fileLoading" class="search-hint">加载中…</div>
        <div v-else-if="files === null" class="tool-result empty">无法读取项目目录</div>
        <div v-else-if="files.length === 0" class="tool-result empty">
          项目文件夹是空的 —— 可在资源管理器中添加文件
          <button class="btn btn-sm project-empty-open" @click="openFolder('')">
            打开文件夹
          </button>
        </div>
        <div v-else class="project-file-list">
          <div
            v-for="f in files"
            :key="f.path"
            class="project-file-row"
            :class="{ dir: f.isDir }"
          >
            <button
              class="project-file-main"
              :title="f.isDir ? `进入 ${f.name}` : `用默认应用打开 ${f.name}`"
              @click="f.isDir ? (cwd = f.path) : openFile(f.path)"
            >
              <span class="file-kind file-kind-doc">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8zM14 3v5h5" />
                </svg>
              </span>
              <span class="project-file-name">{{ f.name }}</span>
              <span class="project-file-size">{{ f.isDir ? "" : formatSize(f.size) }}</span>
            </button>
            <button
              v-if="f.isDir"
              class="btn btn-sm project-file-open"
              title="在资源管理器中打开该文件夹"
              @click="openFolder(f.path)"
            >
              打开文件夹
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
