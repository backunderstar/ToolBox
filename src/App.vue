<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ping, type PingInfo } from "./core/ipc";
import { useVault } from "./core/vault";
import { usePlugins } from "./core/plugins";
import { useNav } from "./core/navigation";
import { loadLayoutPrefs, saveLayoutPrefs } from "./core/layout";
import {
  loadNavConfig,
  saveNavConfig,
  normalizeNav,
  groupIdFor,
  type NavConfig,
  type NavItemDef,
} from "./core/navPrefs";
import { floatToggle } from "./core/api";
import {
  applyTheme,
  getInitialTheme,
  toggleTheme,
  getThemeBase,
  findTheme,
  SYSTEM_THEME_ID,
} from "./themes/themes";
import ErrorBoundary from "./components/ErrorBoundary.vue";
import TopBar from "./components/TopBar.vue";
import Sidebar from "./components/Sidebar.vue";
import StatusBar from "./components/StatusBar.vue";
import WelcomeView from "./components/WelcomeView.vue";
import PluginUiView from "./components/PluginUiView.vue";
import FloatApp from "./components/FloatApp.vue";
import LoadingView from "./components/LoadingView.vue";
import CoreDisabled from "./components/CoreDisabled.vue";
import "./styles/tokens.css";
import "./styles/base.css";
/* 样式按域拆分（原 app.css 3600 行）：外壳/插件页/设置/各核心插件视图。
   顺序即级联顺序：shell（外壳+按钮）→ 各视图（同层类名不冲突，插件
   UI 复用的宿主类名按需覆盖外壳细节）。 */
import "./styles/shell.css";
import "./styles/notes.css";
import "./styles/plugins.css";
import "./styles/settings.css";
import "./styles/ai.css";
import "./styles/checklists.css";
import "./styles/projects.css";

/* 低频视图懒加载（defineAsyncComponent + 代码分割）：设置页/插件页包含较多
   组件与样式，按需加载减小首屏 JS parse 量；概览等首屏视图保持静态 import。 */
const SettingsView = defineAsyncComponent({
  loader: () => import("./components/SettingsView.vue"),
  loadingComponent: LoadingView,
});
const PluginsView = defineAsyncComponent({
  loader: () => import("./components/PluginsView.vue"),
  loadingComponent: LoadingView,
});

/** 宿主固定路由的视图 id（ViewId 联合）。外部插件声明同名 nav id 会与内置
 *  路由冲突（侧边栏显示被覆盖，点击仍走内置分支，显示与跳转不一致）——
 *  渲染前过滤。核心插件的同名声明（notes/checklist/…）是合法的，负责提供
 *  侧边栏标签/图标/分组。用 Set<string>：检查对象是任意插件声明的 nav id。 */
const RESERVED_VIEW_IDS = new Set<string>([
  "overview",
  "notes",
  "plugins",
  "checklist",
  "projects",
  "ai",
  "blog",
  "settings",
]);

/** 是否为浮窗窗口（加载同一前端入口，按窗口 label 分流） */
function isFloatWindow(): boolean {
  try {
    return getCurrentWindow().label === "float";
  } catch {
    return false; // 浏览器 mock 环境无 Tauri
  }
}

const isFloat = isFloatWindow();

/* ---- AppInner 逻辑（浮窗分支在模板按 isFloat 分流） ---- */
const vault = useVault();
const pluginCtx = usePlugins();
const nav = useNav();

const view = computed(() => nav.state.view);

const themeId = ref<string>(getInitialTheme());
const pingInfo = ref<PingInfo | null>(null);
/* Ctrl+K 聚焦信号（自增触发 TopBar 聚焦） */
const focusTick = ref(0);

/* 布局偏好：导航折叠（持久化） */
const navCollapsed = ref(loadLayoutPrefs().navCollapsed);

/* 导航栏全配置：分组/顺序/隐藏/标签图标覆盖（localStorage 持久化；归一化兜底插件增删） */
const navConfig = ref<NavConfig | null>(loadNavConfig());

/* 导航项定义底表：静态项 + 已启用插件的 nav 声明 */
const navDefs = computed<NavItemDef[]>(() => [
  { id: "overview", label: "概览", icon: "grid", groupId: "work" },
  // 插件管理页归「系统」组（产品决策；老用户旧布局由 navPrefs 一次性迁移）
  { id: "plugins", label: "插件", icon: "puzzle", groupId: "system" },
  { id: "settings", label: "设置", icon: "gear", groupId: "system", fixed: true },
  ...pluginCtx.navItems.value
    // 过滤与宿主固定路由冲突的外部插件 nav 声明（核心插件的同名声明合法）
    .filter((n) => !RESERVED_VIEW_IDS.has(n.id) || n.pluginId.startsWith("core-"))
    .map((n) => ({
      id: n.id,
      label: n.label,
      icon: n.icon,
      groupId: groupIdFor(n.group),
    })),
]);

/* 归一化配置（渲染与设置页共用；失效项清理/新项补齐/settings 强制可见） */
const navConfigNorm = computed(() => normalizeNav(navConfig.value, navDefs.value));

watch(navConfigNorm, (n) => saveNavConfig(n));
watch(navCollapsed, (c) => saveLayoutPrefs({ navCollapsed: c }));

/** 基于当前归一化配置修改并保存（折叠/编辑统一入口） */
function updateNav(fn: (cur: NavConfig) => NavConfig): void {
  navConfig.value = fn(normalizeNav(navConfig.value, navDefs.value));
}

function toggleNavGroup(groupId: string): void {
  updateNav((cur) => ({
    ...cur,
    groups: cur.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)),
  }));
}

/* 应用主题：内置/自定义同步，插件主题异步读 css（双通道）。
   依赖 pluginThemeKey：插件列表加载完成后重放——重启后持久化的插件
   主题 id 此刻才可解析；插件被禁用/卸载时由此触发回落（下方 watch）。 */
watch(
  () => [themeId.value, pluginCtx.pluginThemeKey.value] as const,
  () => void applyTheme(themeId.value),
);

/* 跟随系统模式：监听系统亮暗切换，变化时实时重应用主题
   （resolveThemeId 会把 system 解析成当前系统 base 的默认主题）。 */
watchEffect((onCleanup) => {
  if (themeId.value !== SYSTEM_THEME_ID) return;
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq?.addEventListener) return;
  const onChange = () => void applyTheme(SYSTEM_THEME_ID);
  mq.addEventListener("change", onChange);
  onCleanup(() => mq.removeEventListener("change", onChange));
});

/* 当前主题是皮肤插件主题但插件已禁用/卸载：回落到默认亮色 */
watch(
  () => [themeId.value, pluginCtx.pluginThemeKey.value] as const,
  ([id]) => {
    const t = findTheme(id);
    if (t?.source === "plugin" && !pluginCtx.pluginThemeKey.value.split(",").includes(id)) {
      themeId.value = "default-light";
    }
  },
);

onMounted(() => {
  ping()
    .then((p) => {
      pingInfo.value = p;
    })
    .catch(() => {
      pingInfo.value = {
        message: "preview",
        coreVersion: "—",
        os: "浏览器预览（未连接 Tauri 核心）",
      };
    });
});

function toggleThemeMode(): void {
  themeId.value = toggleTheme(themeId.value);
}

/* Ctrl+K：任意视图下聚焦顶栏全局搜索（不切视图） */
onMounted(() => {
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      focusTick.value += 1;
    }
  };
  window.addEventListener("keydown", onKey);
  onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
});

const themeMode = computed(() => getThemeBase(themeId.value));
const themeName = computed(() => findTheme(themeId.value)?.name ?? themeId.value);

const vaultName = computed(() =>
  vault.state.path ? (vault.state.path.split(/[\\/]/).pop() ?? vault.state.path) : null,
);

/* 外部插件自带前端的动态路由：非内置 view（如插件 nav 声明的 id）时，
   查插件导航表 → 命中且插件启用且自带前端 → 渲染该插件的 PluginUiView。 */
const pluginView = computed<string | null>(() => {
  if (
    view.value === "overview" ||
    view.value === "plugins" ||
    view.value === "settings" ||
    view.value === "notes" ||
    view.value === "checklist" ||
    view.value === "projects" ||
    view.value === "ai" ||
    view.value === "blog"
  ) {
    return null; // 内置视图由固定分支处理
  }
  const navItem = pluginCtx.navItems.value.find((n) => n.id === view.value);
  if (!navItem) return null;
  const pl = pluginCtx.state.plugins.find((p) => p.id === navItem.pluginId);
  if (!pl?.enabled || !pl.ui) return null;
  return navItem.pluginId;
});

/** 核心插件视图守卫：插件启用才渲染（未知/未加载时默认放行）。 */
function corePluginEnabled(id: string): boolean {
  const p = pluginCtx.state.plugins.find((x) => x.id === id);
  return p ? p.enabled : true;
}

function openSearchResult(p: string): void {
  // 搜索结果 = 任意 vault 下 .md：必须走 openNote 全流程——笔记界面是
  // 插件自带前端，只靠 host vault.openFile 更新宿主状态不会让编辑器真正
  // 打开文件；要经 __TB_PENDING_NOTE__ + tb:open-note 事件驱动插件 UI 打开
  nav.openNote(p);
  vault.setQuery("");
}

function toggleFloat(): void {
  void floatToggle().catch(() => undefined);
}
</script>

<template>
  <FloatApp v-if="isFloat" />
  <ErrorBoundary v-else>
    <div class="app" data-part="app">
      <TopBar
        :theme="themeMode"
        :on-toggle-theme="toggleThemeMode"
        :query="vault.state.query"
        :on-query-change="vault.setQuery"
        :search-enabled="!!vault.state.path"
        :results="vault.state.results"
        :searching="vault.state.searching"
        :on-open-result="openSearchResult"
        :vault-name="vaultName"
        :on-pick-vault="vault.pickVault"
        :nav-collapsed="navCollapsed"
        :on-toggle-nav="() => (navCollapsed = !navCollapsed)"
        :on-toggle-float="toggleFloat"
        :focus-signal="focusTick"
      />
      <div class="body">
        <Sidebar
          :active-view="view"
          :on-select="nav.go"
          :collapsed="navCollapsed"
          :config="navConfigNorm"
          :defs="navDefs"
          :on-toggle-group="toggleNavGroup"
        />
        <main class="main" data-part="main">
          <WelcomeView
            v-if="view === 'overview'"
            :ping="pingInfo"
            :theme-name="themeName"
            :plugins="pluginCtx.state.plugins"
            :on-open-notes="() => nav.go('notes')"
            :on-open-plugins="() => nav.go('plugins')"
          />
          <PluginsView v-else-if="view === 'plugins'" />
          <template v-else-if="view === 'checklist'">
            <PluginUiView
              v-if="corePluginEnabled('core-checklists')"
              plugin-id="core-checklists"
            />
            <CoreDisabled v-else name="清单" />
          </template>
          <template v-else-if="view === 'projects'">
            <PluginUiView
              v-if="corePluginEnabled('core-projects')"
              plugin-id="core-projects"
            />
            <CoreDisabled v-else name="项目" />
          </template>
          <template v-else-if="view === 'ai'">
            <PluginUiView v-if="corePluginEnabled('core-ai')" plugin-id="core-ai" />
            <CoreDisabled v-else name="AI 整理" />
          </template>
          <template v-else-if="view === 'blog'">
            <PluginUiView v-if="corePluginEnabled('core-blog')" plugin-id="core-blog" />
            <CoreDisabled v-else name="博客发布" />
          </template>
          <template v-else-if="view === 'settings'">
            <SettingsView
              :theme-id="themeId"
              :on-set-theme-id="(id: string) => (themeId = id)"
              :ping="pingInfo"
              :nav-config="navConfigNorm"
              :defs="navDefs"
              :on-nav-change="(c: NavConfig) => (navConfig = c)"
            />
          </template>
          <template v-else-if="view === 'notes'">
            <PluginUiView v-if="corePluginEnabled('core-notes')" plugin-id="core-notes" />
            <CoreDisabled v-else name="笔记" />
          </template>
          <template v-else>
            <!-- 未知视图（nav 声明但插件未启用/无自带前端）：明确占位 -->
            <PluginUiView v-if="pluginView" :plugin-id="pluginView" />
            <div v-else class="empty-state">
              <h2>未找到页面</h2>
              <p>该视图不存在或对应插件未启用</p>
            </div>
          </template>
        </main>
      </div>
      <StatusBar
        :ping="pingInfo"
        :theme="themeMode"
        :vault-name="vaultName"
        :status="vault.state.status"
      />
    </div>
  </ErrorBoundary>
</template>
