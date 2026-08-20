import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ping, type PingInfo } from "./core/ipc";
import { VaultProvider, useVault } from "./core/vault";
import { PluginProvider, usePlugins } from "./core/plugins";
import { NavProvider } from "./core/navigation";

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
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, getInitialTheme, toggleTheme, getThemeBase, findTheme, SYSTEM_THEME_ID } from "./themes/themes";
import { TopBar } from "./components/TopBar";
import { Sidebar, type ViewId } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { WelcomeView } from "./components/WelcomeView";
import { PluginUiView } from "./components/PluginUiView";
import { FloatApp } from "./components/FloatApp";
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

/* 低频视图懒加载（React.lazy + 代码分割）：设置页/插件页包含较多组件与样式，
   按需加载减小首屏 JS parse 量；概览等首屏视图保持静态 import。 */
const SettingsView = lazy(() =>
  import("./components/SettingsView").then((m) => ({ default: m.SettingsView })),
);
const PluginsView = lazy(() =>
  import("./components/PluginsView").then((m) => ({ default: m.PluginsView })),
);

/** 宿主固定路由的视图 id（ViewId 联合）。外部插件声明同名 nav id 会与内置路由
 *  冲突（侧边栏显示被覆盖，点击仍走内置分支，显示与跳转不一致）——渲染前过滤。
 *  核心插件的同名声明（notes/checklist/…）是合法的，负责提供侧边栏标签/图标/分组。
 *  用 Set<string>（而非 Set<ViewId>）：检查对象是任意插件声明的 nav id，语义即
 *  "保留 id 集合"，无需类型转换。 */
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

export default function App() {
  const [isFloat] = useState(isFloatWindow);
  if (isFloat) {
    return <FloatApp />;
  }
  return (
    <ErrorBoundary>
      <VaultProvider>
        <PluginProvider>
          <AppInner />
        </PluginProvider>
      </VaultProvider>
    </ErrorBoundary>
  );
}

function AppInner() {
  const vault = useVault();
  const pluginCtx = usePlugins();
  const [view, setView] = useState<ViewId>(() =>
    new URLSearchParams(window.location.search).has("mock") ? "notes" : "overview",
  );
  const [themeId, setThemeId] = useState<string>(getInitialTheme);
  const [pingInfo, setPingInfo] = useState<PingInfo | null>(null);
  /* Ctrl+K 聚焦信号（自增触发 TopBar 聚焦） */
  const [focusTick, setFocusTick] = useState(0);

  /* 布局偏好：导航折叠（持久化）。文件面板/专注模式已随宿主回退笔记视图删除 */
  const [navCollapsed, setNavCollapsed] = useState(() => loadLayoutPrefs().navCollapsed);

  /* 导航栏全配置：分组/顺序/隐藏/标签图标覆盖（localStorage 持久化；归一化兜底插件增删） */
  const [navConfig, setNavConfig] = useState<NavConfig | null>(() => loadNavConfig());

  /* 导航项定义底表：静态项 + 已启用插件的 nav 声明（插件项默认按声明 group 归组，
     用户可在设置页任意移动/排序/改名换图标） */
  const navDefs = useMemo<NavItemDef[]>(
    () => [
      { id: "overview", label: "概览", icon: "grid", groupId: "work" },
      // 插件管理页归「系统」组（产品决策；老用户旧布局由 navPrefs 一次性迁移）
      { id: "plugins", label: "插件", icon: "puzzle", groupId: "system" },
      { id: "settings", label: "设置", icon: "gear", groupId: "system", fixed: true },
      ...pluginCtx.navItems
        // 过滤与宿主固定路由冲突的外部插件 nav 声明（核心插件的同名声明合法）
        .filter((n) => !RESERVED_VIEW_IDS.has(n.id) || n.pluginId.startsWith("core-"))
        .map((n) => ({
          id: n.id,
          label: n.label,
          icon: n.icon,
          groupId: groupIdFor(n.group),
        })),
    ],
    [pluginCtx.navItems],
  );

  /* 归一化配置（渲染与设置页共用；失效项清理/新项补齐/settings 强制可见） */
  const nav = useMemo(() => normalizeNav(navConfig, navDefs), [navConfig, navDefs]);

  useEffect(() => {
    saveNavConfig(nav);
  }, [nav]);

  /** 基于当前归一化配置修改并保存（折叠/编辑统一入口） */
  const updateNav = (fn: (cur: NavConfig) => NavConfig) => {
    setNavConfig((prev) => fn(normalizeNav(prev, navDefs)));
  };

  const toggleNavGroup = (groupId: string) => {
    updateNav((cur) => ({
      ...cur,
      groups: cur.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)),
    }));
  };

  useEffect(() => {
    saveLayoutPrefs({ navCollapsed });
  }, [navCollapsed]);

  /* 应用主题：内置/自定义同步，插件主题异步读 css（双通道）。
     依赖 pluginThemeKey：插件列表加载完成后重放——重启后持久化的插件
     主题 id 此刻才可解析；插件被禁用/卸载时由此触发回落（下方 effect）。 */
  useEffect(() => {
    void applyTheme(themeId);
  }, [themeId, pluginCtx.pluginThemeKey]);

  /* 跟随系统模式：监听系统亮暗切换，变化时实时重应用主题
     （resolveThemeId 会把 system 解析成当前系统 base 的默认主题）。 */
  useEffect(() => {
    if (themeId !== SYSTEM_THEME_ID) return;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq?.addEventListener) return;
    const onChange = () => void applyTheme(SYSTEM_THEME_ID);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themeId]);

  /* 当前主题是皮肤插件主题但插件已禁用/卸载：回落到默认亮色
     （applyTheme 对"暂不可用"主题只应用外观不覆盖持久化值，这里显式复位）。 */
  useEffect(() => {
    const t = findTheme(themeId);
    if (t?.source === "plugin" && !pluginCtx.pluginThemeKey.split(",").includes(themeId)) {
      setThemeId("default-light");
    }
  }, [themeId, pluginCtx.pluginThemeKey]);

  useEffect(() => {
    ping()
      .then(setPingInfo)
      .catch(() =>
        setPingInfo({
          message: "preview",
          coreVersion: "—",
          os: "浏览器预览（未连接 Tauri 核心）",
        }),
      );
  }, []);

  const toggleThemeMode = () => setThemeId((t) => toggleTheme(t));

  /* Ctrl+K：任意视图下聚焦顶栏全局搜索（不切视图——搜索本就是全局的，
     结果点击自会跳转笔记视图；历史上曾强制 setView("notes")，与"任意视图
     可用"的语义相悖，已移除）。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setFocusTick((t) => t + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const themeMode = getThemeBase(themeId);
  const themeName = findTheme(themeId)?.name ?? themeId;

  const vaultName = vault.path ? (vault.path.split(/[\\/]/).pop() ?? vault.path) : null;

  /* 外部插件自带前端的动态路由：非内置 view（如插件 nav 声明的 id）时，
     查插件导航表 → 命中且插件启用且自带前端 → 渲染该插件的 PluginUiView。
     这样任何插件声明 nav + ui 即可获得侧边栏入口与独立页面（无需宿主改代码）。 */
  const pluginView = useMemo(() => {
    if (
      view === "overview" ||
      view === "plugins" ||
      view === "settings" ||
      view === "notes" ||
      view === "checklist" ||
      view === "projects" ||
      view === "ai" ||
      view === "blog"
    ) {
      return null; // 内置视图由上方固定分支处理
    }
    const navItem = pluginCtx.navItems.find((n) => n.id === view);
    if (!navItem) return null;
    const pl = pluginCtx.plugins.find((p) => p.id === navItem.pluginId);
    if (!pl?.enabled || !pl.ui) return null;
    return <PluginUiView pluginId={navItem.pluginId} />;
  }, [view, pluginCtx.navItems, pluginCtx.plugins]);

  const navValue = useMemo(
    () => ({
      view,
      go: (v: ViewId) => {
        setView(v);
      },
      openNote: (rel: string) => {
        setView("notes");
        // 笔记视图是插件自带前端：插件从标记/事件拿到要打开的笔记并自行读盘，
        // 打开后经 tb:vault-active 回写宿主状态。宿主不再调 openFile 二次读盘——
        // 那会造成重复读盘，且与插件回写 content 竞争触发「已取消切换」误报。
        (window as unknown as Record<string, unknown>).__TB_PENDING_NOTE__ = rel;
        window.dispatchEvent(new CustomEvent("tb:open-note", { detail: rel }));
      },
      openChecklist: () => {
        setView("checklist");
      },
    }),
    [view],
  );

  return (
    <NavProvider value={navValue}>
      <div className="app" data-part="app">
        <TopBar
          theme={themeMode}
          onToggleTheme={toggleThemeMode}
          query={vault.query}
          onQueryChange={vault.setQuery}
          // 顶栏搜索 = 全局全文搜索（vault 根下所有 .md，用户决策恢复）：
          // 有工作区即可用；结果下拉里点击即打开对应文件
          searchEnabled={!!vault.path}
          results={vault.results}
          searching={vault.searching}
          onOpenResult={(p) => {
            // 搜索结果 = 任意 vault 下 .md：必须走 openNote 全流程——笔记界面是
            // 插件自带前端（独立 React 应用），只靠 host vault.openFile 更新宿主状态
            // 不会让编辑器真正打开文件；要经 __TB_PENDING_NOTE__ + tb:open-note 事件
            // 驱动插件 UI 打开（与 AI 整理跳转同一机制）
            navValue.openNote(p);
            vault.setQuery("");
          }}
          vaultName={vaultName}
          onPickVault={vault.pickVault}
          navCollapsed={navCollapsed}
          onToggleNav={() => setNavCollapsed((c) => !c)}
          onToggleFloat={() => void floatToggle().catch(() => undefined)}
          focusSignal={focusTick}
        />
        <div className="body">
          <Sidebar
            activeView={view}
            onSelect={(v) => {
              setView(v);
            }}
            collapsed={navCollapsed}
            config={nav}
            defs={navDefs}
            onToggleGroup={toggleNavGroup}
          />
          <main className="main" data-part="main">
            <Suspense fallback={<div className="empty-state">加载中…</div>}>
              {view === "overview" ? (
              <WelcomeView
                ping={pingInfo}
                themeName={themeName}
                plugins={pluginCtx.plugins}
                onOpenNotes={() => setView("notes")}
                onOpenPlugins={() => setView("plugins")}
              />
            ) : view === "plugins" ? (
              <PluginsView />
            ) : view === "checklist" ? (
              corePluginEnabled(pluginCtx.plugins, "core-checklists") ? (
                <PluginUiView pluginId="core-checklists" />
              ) : (
                <CoreDisabled
                  name="清单"
                  onGoPlugins={() => {
                    setView("plugins");
                  }}
                />
              )
            ) : view === "projects" ? (
              corePluginEnabled(pluginCtx.plugins, "core-projects") ? (
                <PluginUiView pluginId="core-projects" />
              ) : (
                <CoreDisabled
                  name="项目"
                  onGoPlugins={() => {
                    setView("plugins");
                  }}
                />
              )
            ) : view === "ai" ? (
              corePluginEnabled(pluginCtx.plugins, "core-ai") ? (
                <PluginUiView pluginId="core-ai" />
              ) : (
                <CoreDisabled
                  name="AI 整理"
                  onGoPlugins={() => {
                    setView("plugins");
                  }}
                />
              )
            ) : view === "blog" ? (
              corePluginEnabled(pluginCtx.plugins, "core-blog") ? (
                <PluginUiView pluginId="core-blog" />
              ) : (
                <CoreDisabled
                  name="博客发布"
                  onGoPlugins={() => {
                    setView("plugins");
                  }}
                />
              )
            ) : view === "settings" ? (
              <SettingsView
                themeId={themeId}
                onSetThemeId={setThemeId}
                ping={pingInfo}
                navConfig={nav}
                defs={navDefs}
                onNavChange={setNavConfig}
              />
            ) : view === "notes" ? (
              corePluginEnabled(pluginCtx.plugins, "core-notes") ? (
                <PluginUiView pluginId="core-notes" />
              ) : (
                <CoreDisabled
                  name="笔记"
                  onGoPlugins={() => {
                    setView("plugins");
                  }}
                />
              )
            ) : (
              (pluginView ?? (
                // 未知视图（nav 声明但插件未启用/无自带前端）：明确占位
                <div className="empty-state">
                  <h2>未找到页面</h2>
                  <p>该视图不存在或对应插件未启用</p>
                </div>
              ))
            )}
            </Suspense>
          </main>
        </div>
        <StatusBar ping={pingInfo} theme={themeMode} vaultName={vaultName} status={vault.status} />
      </div>
    </NavProvider>
  );
}

/** 核心插件视图守卫：插件启用才渲染（未知/未加载时默认放行）。 */
function corePluginEnabled(plugins: { id: string; enabled: boolean }[], id: string): boolean {
  const p = plugins.find((x) => x.id === id);
  return p ? p.enabled : true;
}

/** 核心插件被禁用时的占位（引导去插件页启用）。 */
function CoreDisabled({ name, onGoPlugins }: { name: string; onGoPlugins: () => void }) {
  return (
    <div className="empty-state">
      <h2>{name}功能已禁用</h2>
      <p>该功能是核心插件，可在插件页重新启用</p>
      <button className="btn" onClick={onGoPlugins}>
        去插件页
      </button>
    </div>
  );
}
