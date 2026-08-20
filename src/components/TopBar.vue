<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Icon from "./Icon.vue";
import type { ThemeMode } from "../themes/themes";
import { APP_TAG } from "../core/version";
import type { SearchHit } from "../core/api";

/**
 * 顶栏（应用外壳）：导航折叠 / 品牌 / 工作区选择 / 全局搜索（任意视图可用，
 * Ctrl+K 聚焦，↑↓ 选择 Enter 打开 Esc 清空）/ 主题亮暗切换 / 桌面浮窗开关。
 * 搜索下拉的状态与键盘导航全在本组件内（activeIdx + 相对时间 + 计数）。
 *
 * 迁移说明：props 回调函数写法与 React 版 1:1（函数作为 props 传入）。
 */
const props = defineProps<{
  theme: ThemeMode;
  onToggleTheme: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  searchEnabled: boolean;
  /** 全局搜索命中（vault.results；null = 未搜索/已清空） */
  results: SearchHit[] | null;
  /** 搜索进行中 */
  searching: boolean;
  /** 点击搜索结果：打开对应文件 */
  onOpenResult: (path: string) => void;
  vaultName: string | null;
  onPickVault: () => void;
  navCollapsed: boolean;
  onToggleNav: () => void;
  /** 显示 / 隐藏桌面浮窗（快速待办） */
  onToggleFloat: () => void;
  /** Ctrl+K 快捷键聚焦信号（App 层自增触发） */
  focusSignal?: number;
}>();

/** 搜索结果下拉最多渲染条数：全文搜索可轻易上百条，全量渲染 DOM 开销大。
 *  截断超出部分并在下拉底部提示（键盘导航边界按可见条数计算，与渲染一致）。 */
const MAX_RESULTS = 50;

/** 相对时间：mtime（UNIX 毫秒）→ "刚刚 / x 分钟前 / x 小时前 / x 天前"。 */
function formatRelTime(mtime?: number): string {
  if (!mtime || mtime <= 0) return "";
  const diff = Date.now() - mtime;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

const searchRef = ref<HTMLInputElement | null>(null);
/* S1：键盘导航当前选中项（-1 = 无选择）。结果变化时重置。 */
const activeIdx = ref(-1);
watch(
  () => props.results,
  () => {
    activeIdx.value = -1;
  },
);

/* Ctrl+K：聚焦搜索框 */
watch(
  () => props.focusSignal,
  (sig) => {
    if (sig && sig > 0 && searchRef.value) {
      searchRef.value.focus();
      searchRef.value.select();
    }
  },
);

const visibleResults = computed(() => props.results?.slice(0, MAX_RESULTS) ?? []);

function onInput(e: Event): void {
  props.onQueryChange((e.target as HTMLInputElement).value);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    const n = Math.min(props.results?.length ?? 0, MAX_RESULTS);
    activeIdx.value = n > 0 ? Math.min(activeIdx.value + 1, n - 1) : -1;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx.value = Math.max(activeIdx.value - 1, -1);
  } else if (e.key === "Enter") {
    // 有选中项才消费 Enter（否则放行，输入框默认无副作用）
    if (activeIdx.value >= 0 && props.results && props.results[activeIdx.value]) {
      e.preventDefault();
      props.onOpenResult(props.results[activeIdx.value].path);
    }
  } else if (e.key === "Escape") {
    // 清空 → vault 层 results 置 null，下拉关闭
    props.onQueryChange("");
  }
}
</script>

<template>
  <header class="topbar" data-part="topbar">
    <button
      class="icon-btn"
      @click="onToggleNav"
      :title="navCollapsed ? '展开导航侧栏' : '收起导航侧栏'"
      aria-label="切换导航侧栏"
    >
      <Icon name="panel-left" :size="15" />
    </button>

    <div class="topbar-brand">
      <span class="topbar-title">ToolBox</span>
      <span class="topbar-tag">{{ APP_TAG }}</span>
    </div>

    <button class="workspace-btn" @click="onPickVault" title="选择 / 切换工作区文件夹">
      <Icon name="folder" :size="13" />
      <span>{{ vaultName ?? "选择工作区" }}</span>
    </button>

    <div
      class="search"
      :class="{ disabled: !searchEnabled }"
      :title="
        searchEnabled
          ? '搜索文件名与内容（Ctrl+K 聚焦，↑/↓ 选择，Enter 打开）'
          : '进入「笔记」并选择工作区后可用'
      "
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        ref="searchRef"
        type="text"
        placeholder="全局搜索（文件名 + 内容）"
        :value="query"
        :disabled="!searchEnabled"
        @input="onInput"
        @keydown="onKeyDown"
      />
      <kbd>Ctrl K</kbd>
      <!-- 全局搜索结果下拉：文件名匹配优先（mtime 降序）；source 标记插件提供者命中 -->
      <div v-if="searchEnabled && query.trim()" class="search-dropdown">
        <div v-if="searching" class="search-hint">搜索中…</div>
        <template v-else-if="results !== null">
          <div v-if="results.length === 0" class="search-hint">无结果</div>
          <template v-else>
            <!-- 结果截断：全文搜索可轻易上百条，全量渲染会让下拉 DOM 爆炸 -->
            <button
              v-for="(r, i) in visibleResults"
              :key="`${r.source ?? 'file'}:${r.path}`"
              class="search-item"
              :class="{ active: i === activeIdx }"
              @click="onOpenResult(r.path)"
              @mouseenter="activeIdx = i"
              :title="r.snippet"
            >
              <span class="search-item-name">{{ r.filename }}</span>
              <span class="search-item-path">{{ r.path }}</span>
              <span v-if="r.mtime" class="search-item-time">{{ formatRelTime(r.mtime) }}</span>
              <span v-if="r.source" class="badge badge-provider">{{ r.source }}</span>
            </button>
            <div class="search-meta">
              {{
                results.length > MAX_RESULTS
                  ? `共 ${results.length} 条，仅显示前 ${MAX_RESULTS} 条（继续输入以缩小范围）`
                  : `共 ${results.length} 条结果`
              }}
            </div>
          </template>
        </template>
      </div>
    </div>

    <div class="spacer" />

    <button
      class="icon-btn"
      @click="onToggleFloat"
      title="显示 / 隐藏桌面浮窗（快速待办）"
      aria-label="切换浮窗"
    >
      <Icon name="float" :size="15" />
    </button>

    <button
      class="icon-btn"
      @click="onToggleTheme"
      :title="theme === 'light' ? '切换到暗色' : '切换到亮色'"
      aria-label="切换主题"
    >
      <Icon :name="theme === 'light' ? 'moon' : 'sun'" />
    </button>
  </header>
</template>
