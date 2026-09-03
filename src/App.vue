<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch, watchEffect } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ping, type PingInfo } from "./core/ipc";
import { appSettingsGet, appSettingsSet } from "./core/api";
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
import { floatToggle, openInExplorer } from "./core/api";
import { triggerPluginAction } from "./core/plugins";
import { useTauriListen } from "./core/useTauriListen";
import { PromptHost } from "./core/prompt";
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
import WelcomeView from "./views/WelcomeView.vue";
import OnboardingView from "./views/OnboardingView.vue";
import PluginUiView from "./components/PluginUiView.vue";
import FloatApp from "./views/FloatApp.vue";
import LoadingView from "./components/LoadingView.vue";
import Icon from "./components/Icon.vue";
import "./styles/tokens.css";
import "./styles/base.css";
/* 样式按域拆分（外壳 / 插件页 / 设置）：顺序即级联顺序。历史遗留的
   notes/ai/checklists/projects.css 已随 2026-08 教学基线收敛删除，
   仍在用的通用类（empty-state、deps-output、confirm-*、nav-settings-* 等）
   已迁移到 plugins.css / settings.css（注意 CSS 注释里不要出现斜杠星号组合）。 */
import "./styles/shell.css";
import "./styles/plugins.css";
import "./styles/settings.css";

/* 低频视图懒加载（defineAsyncComponent + 代码分割）：设置页/插件页包含较多
   组件与样式，按需加载减小首屏 JS parse 量；概览等首屏视图保持静态 import。 */
const SettingsView = defineAsyncComponent({
  loader: () => import("./views/SettingsView.vue"),
  loadingComponent: LoadingView,
});
const PluginsView = defineAsyncComponent({
  loader: () => import("./views/PluginsView.vue"),
  loadingComponent: LoadingView,
});
const FilesView = defineAsyncComponent({
  loader: () => import("./views/FilesView.vue"),
  loadingComponent: LoadingView,
});
const InputView = defineAsyncComponent({
  loader: () => import("./views/InputView.vue"),
  loadingComponent: LoadingView,
});

/** 宿主固定路由的视图 id（ViewId 联合）。外部插件声明同名 nav id 会与内置
 *  路由冲突（侧边栏显示被覆盖，点击仍走内置分支，显示与跳转不一致）——
 *  渲染前过滤。用 Set<string>：检查对象是任意插件声明的 nav id。 */
const RESERVED_VIEW_IDS = new Set<string>(["overview", "files", "input", "plugins", "settings"]);

/** 是否为浮窗窗口（加载同一前端入口，按窗口 label 分流） */
function isFloatWindow(): boolean {
  try {
    return getCurrentWindow().label === "float";
  } catch {
    return false; // 浏览器 mock 环境无 Tauri
  }
}

const isFloat = isFloatWindow();

/* 首启引导：未配置数据根目录（root.json 缺失）→ 全屏引导页（数据根 + 主题）。
   配置完成后 state.root 就绪，v-if 自动切回主界面。 */
const showOnboarding = computed(() => !vault.state.root);
function onOnboardingDone(): void {
  nav.go("overview");
}

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
  // 工作区文件浏览（2026-09 多工作区：浏览当前工作区文件树）
  { id: "files", label: "文件", icon: "folder", groupId: "work" },
  // 文件输入（Inbox，数据根/Input）：未知/待分类文件暂存区（支持拖拽）
  { id: "input", label: "文件输入", icon: "file-text", groupId: "work" },
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

/* ---- 关闭主窗口：按设置分流（托盘常驻 hide / 退出 close）+ 首次询问框 ---- */
const closeAskOpen = ref(false);
const closeAskRemember = ref(false);
let closeAskResolve: ((action: "tray" | "quit") => void) | null = null;

function askCloseAction(): Promise<"tray" | "quit"> {
  closeAskRemember.value = false;
  closeAskOpen.value = true;
  return new Promise((resolve) => {
    closeAskResolve = resolve;
  });
}
function resolveCloseAsk(action: "tray" | "quit"): void {
  closeAskOpen.value = false;
  closeAskResolve?.(action);
  closeAskResolve = null;
}

onMounted(() => {
  if (isFloat) return; // 浮窗窗口不处理主窗口关闭流程
  getCurrentWindow().onCloseRequested(async (event) => {
    const s = await appSettingsGet().catch(() => ({} as Record<string, unknown>));
    // 托盘被禁用或已设为退出：放行（Rust 侧同步判断并退出，含关闭浮窗）
    if (s.trayEnabled === false || s.closeBehavior === "quit") return;
    event.preventDefault();
    const shouldAsk = s.closeAsk !== false; // 首次（未设置）默认询问
    let action: "tray" | "quit" = "tray";
    if (shouldAsk) {
      action = await askCloseAction();
      if (closeAskRemember.value) {
        // 「不再询问」：记住选择，之后直接按行为执行（设置页可重新开启询问）
        void appSettingsSet("closeAsk", false).catch(() => undefined);
      }
    }
    if (action === "quit") {
      // 改为退出模式后再 close：Rust 读到 closeBehavior=quit 放行 → 应用退出
      await appSettingsSet("closeBehavior", "quit").catch(() => undefined);
      await getCurrentWindow().close().catch(() => undefined);
    } else {
      await getCurrentWindow().hide().catch(() => undefined);
    }
  });
});

const themeMode = computed(() => getThemeBase(themeId.value));
const themeName = computed(() => findTheme(themeId.value)?.name ?? themeId.value);

const vaultName = computed(() =>
  vault.state.path ? (vault.state.path.split(/[\\/]/).pop() ?? vault.state.path) : null,
);

/* 外部插件自带前端的动态路由：非内置 view（如插件 nav 声明的 id）时，
   查插件导航表 → 命中且插件启用且自带前端 → 渲染该插件的 PluginUiView。 */
const pluginView = computed<string | null>(() => {
  if (view.value === "overview" || view.value === "plugins" || view.value === "settings") {
    return null; // 内置视图由固定分支处理
  }
  const navItem = pluginCtx.navItems.value.find((n) => n.id === view.value);
  if (!navItem) return null;
  const pl = pluginCtx.state.plugins.find((p) => p.id === navItem.pluginId);
  if (!pl?.enabled || !pl.ui) return null;
  return navItem.pluginId;
});

function openSearchResult(p: string): void {
  // 搜索结果 = 任意 vault 下文件：教学基线下宿主不持有业务视图，
  // 用系统文件管理器定位该文件（用户自己打开查看）
  const vp = vault.state.path;
  if (!vp) return;
  void openInExplorer(`${vp.replace(/\\/g, "/")}/${p}`).catch(() => undefined);
  vault.setQuery("");
}

function toggleFloat(): void {
  void floatToggle().catch(() => undefined);
}

/* 插件顶栏动作（manifest actions 且 topbar=true 的启用插件）→ 统一交互 */
const pluginActions = computed(() =>
  pluginCtx.state.plugins
    .filter((p) => p.enabled)
    .flatMap((p) =>
      (p.actions ?? [])
        .filter((a) => a.topbar)
        .map((a) => ({ pluginId: p.id, id: a.id, label: a.label, icon: a.icon })),
    ),
);

function onPluginAction(pluginId: string, action: string): void {
  void triggerPluginAction(pluginId, action, "topbar");
}

/* 插件通知横幅（process 核心 API `notify` → plugin-event `notification` 事件）：
   右上角滑入提示，5s 自动消失；零外部依赖（不接系统 toast） */
const appNotification = ref<{ title: string; body: string } | null>(null);
useTauriListen<{ pluginId: string; event: string; data: { title?: string; body?: string } }>(
  "plugin-event",
  (e) => {
    if (e.event !== "notification") return;
    appNotification.value = {
      title: e.data?.title ?? "ToolBox",
      body: e.data?.body ?? "",
    };
    setTimeout(() => (appNotification.value = null), 5000);
  },
);
</script>

<template>
  <FloatApp v-if="isFloat" />
  <ErrorBoundary v-else>
    <!-- 首启引导（未配置数据根目录）：配置数据根 + 主题 -->
    <OnboardingView
      v-if="showOnboarding"
      :theme-id="themeId"
      :on-set-theme-id="(id: string) => (themeId = id)"
      :on-done="onOnboardingDone"
    />
    <template v-else>
      <!-- 插件通知横幅（process 核心 API notify → plugin-event notification） -->
    <transition name="notify-pop">
      <div v-if="appNotification" class="app-notification" role="status">
        <strong>{{ appNotification.title }}</strong>
        <span>{{ appNotification.body }}</span>
        <button class="icon-btn sm" aria-label="关闭通知" @click="appNotification = null">
          <Icon name="trash" :size="11" />
        </button>
      </div>
    </transition>
    <!-- 关闭主窗口询问框（首次；勾选「不再询问」后按行为直接执行，设置页可重新开启） -->
    <Transition name="modal">
      <div v-if="closeAskOpen" class="confirm-overlay" role="presentation">
        <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="关闭 ToolBox">
          <h3 class="confirm-title">关闭 ToolBox？</h3>
          <p class="confirm-message">
            关闭后应用将退到系统托盘继续运行，可随时从托盘恢复窗口或退出。
          </p>
          <label class="close-ask-remember">
            <input v-model="closeAskRemember" type="checkbox" />
            <span>不再询问（记住选择，可在设置页重新开启）</span>
          </label>
          <div class="confirm-actions">
            <button class="btn" @click="resolveCloseAsk('tray')">最小化到托盘</button>
            <button class="btn" @click="resolveCloseAsk('quit')">退出应用</button>
          </div>
        </div>
      </div>
    </Transition>

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
        :vault-path="vault.state.path"
        :workspace-root="vault.state.root"
        :workspace-items="vault.state.items"
        :on-switch-workspace="vault.switchWorkspace"
        :on-create-workspace="vault.createWorkspace"
        :on-pick-vault="vault.pickWorkspaceRoot"
        :nav-collapsed="navCollapsed"
        :on-toggle-nav="() => (navCollapsed = !navCollapsed)"
        :on-toggle-float="toggleFloat"
        :focus-signal="focusTick"
        :plugin-actions="pluginActions"
        :on-plugin-action="onPluginAction"
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
          <!-- 视图切换过渡：mode="out-in" 先出后进，避免重叠；key 保证切换触发 -->
          <Transition name="view" mode="out-in">
            <WelcomeView
              v-if="view === 'overview'"
              :key="'overview'"
              :ping="pingInfo"
              :theme-name="themeName"
              :plugins="pluginCtx.state.plugins"
              :on-open-plugins="() => nav.go('plugins')"
            />
            <PluginsView v-else-if="view === 'plugins'" :key="'plugins'" />
            <FilesView v-else-if="view === 'files'" :key="'files'" />
            <InputView v-else-if="view === 'input'" :key="'input'" />
            <SettingsView
              v-else-if="view === 'settings'"
              :key="'settings'"
              :theme-id="themeId"
              :on-set-theme-id="(id: string) => (themeId = id)"
              :ping="pingInfo"
              :nav-config="navConfigNorm"
              :defs="navDefs"
              :on-nav-change="(c: NavConfig) => (navConfig = c)"
            />
            <PluginUiView
              v-else-if="pluginView"
              :key="pluginView"
              :plugin-id="pluginView"
            />
            <div v-else :key="'missing'" class="empty-state">
              <h2>未找到页面</h2>
              <p>该视图不存在或对应插件未启用</p>
            </div>
          </Transition>
        </main>
      </div>
      <StatusBar
        :ping="pingInfo"
        :theme="themeMode"
        :vault-name="vaultName"
        :status="vault.state.status"
      />
    </div>
    </template>
    <PromptHost />
  </ErrorBoundary>
</template>
