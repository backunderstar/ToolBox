<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";
import "./style.css";

/**
 * core-blog 插件自带前端（组件模式）——Vue 3，经宿主 PluginUiView 加载。
 * 宿主注入 api：call → plugin_call（默认调本插件，可跨插件 targetPluginId）/
 * on → plugin-event / context.vault。
 */
interface PostMeta {
  path: string;
  title: string;
  date: string;
  tags: string[];
  status: string;
  mtime: number | null;
}

interface BlogListResult {
  posts: PostMeta[];
  siteGeneratedAt: number | null;
  staleCount: number;
}

const props = defineProps<{ api: PluginBridgeApi }>();

const result = ref<BlogListResult | null>(null);
const title = ref("");
const busy = ref(false);
// 并发守卫：generate/preview 是异步的，busy state 更新有延迟（同帧双击/Enter
// 可并发触发，两个 generate 会同时 remove_dir_all 同一目录）——同步拦截。
let busyGuard = false;
const msg = ref<string | null>(null);
const msgErr = ref(false);

function show(t: string, err = false): void {
  msg.value = t;
  msgErr.value = err;
}

async function refresh(): Promise<void> {
  try {
    result.value = (await props.api.call("blog.list")) as BlogListResult;
  } catch (e) {
    show(String(e), true);
  }
}

onMounted(() => void refresh());

async function generate(): Promise<void> {
  if (busyGuard) return;
  busyGuard = true;
  busy.value = true;
  msg.value = null;
  try {
    const r = (await props.api.call("blog.generate", { siteTitle: title.value })) as {
      posts: number;
    };
    show(`站点已生成：${r.posts} 篇`);
    title.value = "";
    await refresh();
  } catch (e) {
    show(String(e), true);
  } finally {
    busyGuard = false;
    busy.value = false;
  }
}

async function preview(): Promise<void> {
  if (busyGuard) return;
  busyGuard = true;
  busy.value = true;
  msg.value = null;
  try {
    const url = (await props.api.call("blog.previewStart")) as string;
    show(`预览：${url}`);
    window.open(url, "_blank");
  } catch (e) {
    show(String(e), true);
  } finally {
    busyGuard = false;
    busy.value = false;
  }
}

async function openFolder(): Promise<void> {
  try {
    await props.api.call("blog.openFolder");
  } catch (e) {
    show(String(e), true);
  }
}

/** 发布状态切换：改笔记 frontmatter 的 status 字段（经 core-notes 读写） */
async function toggleStatus(p: PostMeta): Promise<void> {
  try {
    const raw = (await props.api.call("notes.read", { rel: p.path }, "core-notes")) as string;
    const next = raw.replace(
      /^(status\s*:\s*)(\S+)/m,
      (_, k: string, v: string) => `${k}${v === "published" ? "draft" : "published"}`,
    );
    if (next === raw) {
      show(`「${p.title}」没有 status 字段，无法切换发布状态`, true);
      return;
    }
    await props.api.call("notes.write", { rel: p.path, content: next }, "core-notes");
    await refresh();
    show(`「${p.title}」已${raw.includes("published") ? "撤回草稿" : "发布"}`);
  } catch (e) {
    show(String(e), true);
  }
}

const stale = computed(() => result.value?.staleCount ?? 0);
</script>

<template>
  <div class="blog-plugin-ui">
    <header class="view-header">
      <div>
        <h1>博客发布</h1>
        <p class="view-sub">frontmatter → 站点生成 / 预览 / 发布</p>
      </div>
    </header>

    <div v-if="result?.siteGeneratedAt != null && stale > 0" class="settings-message warn">
      有 {{ stale }} 篇已发布笔记在站点生成后更新过，请重新生成站点
    </div>

    <div class="blog-ui-toolbar">
      <input
        class="settings-input"
        placeholder="站点标题（默认 ToolBox 博客）"
        v-model="title"
        @keydown.enter="generate"
      />
      <button class="btn" @click="generate" :disabled="busy">
        {{ busy ? "处理中…" : "生成站点" }}
      </button>
      <button class="btn" @click="preview" :disabled="busy || result?.siteGeneratedAt == null">
        预览
      </button>
      <button class="btn" @click="openFolder" :disabled="result?.siteGeneratedAt == null">
        打开站点目录
      </button>
    </div>

    <div v-if="msg" class="settings-message" :class="msgErr ? 'err' : 'ok'">{{ msg }}</div>

    <div class="blog-ui-list">
      <div v-if="!result" class="search-hint">加载中…</div>
      <div v-else-if="result.posts.length === 0" class="search-hint">
        还没有笔记（博客文章来自 notes/ 目录）
      </div>
      <div v-for="p in result.posts" :key="p.path" class="blog-ui-row">
        <div class="blog-ui-title">{{ p.title }}</div>
        <div class="blog-ui-meta">
          {{ p.date }} · {{ p.tags.length ? p.tags.join("、") : "无标签" }}
          <span v-if="p.status === 'published'" class="badge badge-status-ready">已发布</span>
          <span v-else class="badge badge-status-stopped">草稿</span>
        </div>
        <button class="btn btn-sm" @click="toggleStatus(p)">
          {{ p.status === "published" ? "撤回草稿" : "发布" }}
        </button>
      </div>
    </div>
  </div>
</template>
