import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ping, type PingInfo } from "./core/ipc";
import { VaultProvider, useVault } from "./core/vault";
import { PluginProvider, usePlugins } from "./core/plugins";
import { NavProvider } from "./core/navigation";
import type { ViewParams } from "./core/navigation";
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
import { applyTheme, getInitialTheme, toggleTheme, getThemeBase, findTheme } from "./themes/themes";
import { TopBar } from "./components/TopBar";
import { Sidebar, type ViewId } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { WelcomeView } from "./components/WelcomeView";
import { PluginsView } from "./components/PluginsView";
import { PluginUiView } from "./components/PluginUiView";
import { SettingsView } from "./components/SettingsView";
import { FloatApp } from "./components/FloatApp";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

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
    new URLSearchParams(window.location.search).has("mock") ? "notes" : "overview"
  );
  const [viewParams, setViewParams] = useState<ViewParams>({});
  const [themeId, setThemeId] = useState<string>(getInitialTheme);
  const [pingInfo, setPingInfo] = useState<PingInfo | null>(null);
  /* Ctrl+K 聚焦信号（自增触发 TopBar 聚焦） */
  const [focusTick, setFocusTick] = useState(0);

  /* 布局偏好：导航折叠（持久化）。文件面板/专注模式已随宿主回退笔记视图删除 */
  const [navCollapsed, setNavCollapsed] = useState(
    () => loadLayoutPrefs().navCollapsed
  );

  /* 导航栏全配置：分组/顺序/隐藏/标签图标覆盖（localStorage 持久化；归一化兜底插件增删） */
  const [navConfig, setNavConfig] = useState<NavConfig | null>(() => loadNavConfig());

  /* 导航项定义底表：静态项 + 已启用插件的 nav 声明（插件项默认按声明 group 归组，
     用户可在设置页任意移动/排序/改名换图标） */
  const navDefs = useMemo<NavItemDef[]>(
    () => [
      { id: "overview", label: "概览", icon: "grid", groupId: "work" },
      { id: "plugins", label: "插件", icon: "puzzle", groupId: "work" },
      { id: "settings", label: "设置", icon: "gear", groupId: "system", fixed: true },
      ...pluginCtx.navItems.map((n) => ({
        id: n.id,
        label: n.label,
        icon: n.icon,
        groupId: groupIdFor(n.group),
      })),
    ],
    [pluginCtx.navItems]
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
      groups: cur.groups.map((g) =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
      ),
    }));
  };

  useEffect(() => {
    saveLayoutPrefs({ navCollapsed });
  }, [navCollapsed]);

  useEffect(() => {
    applyTheme(themeId);
  }, [themeId]);

  useEffect(() => {
    ping()
      .then(setPingInfo)
      .catch(() =>
        setPingInfo({
          message: "preview",
          coreVersion: "—",
          os: "浏览器预览（未连接 Tauri 核心）",
        })
      );
  }, []);

  const toggleThemeMode = () =>
    setThemeId((t) => toggleTheme(t));

  /* Ctrl+K：切到笔记视图并聚焦搜索框（快捷键提示的真实实现） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setView((v) => (v === "notes" ? v : "notes"));
        setFocusTick((t) => t + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const themeMode = getThemeBase(themeId);
  const themeName = findTheme(themeId)?.name ?? themeId;

  const vaultName = vault.path
    ? (vault.path.split(/[\\/]/).pop() ?? vault.path)
    : null;

  /* 跨视图导航（供双向链接跳转）。
     openFile 来自 vault（每次渲染新对象），但 openNote 只需稳定引用：用 ref 包住 */
  const openFileRef = useRef(vault.openFile);
  openFileRef.current = vault.openFile;
  const navValue = useMemo(
    () => ({
      view,
      params: viewParams,
      go: (v: ViewId, params?: ViewParams) => {
        setView(v);
        setViewParams(params ?? {});
      },
      openNote: (rel: string) => {
        setView("notes");
        setViewParams({});
        // 笔记视图是插件自带前端时，插件从标记/事件拿到要打开的笔记（宿主 vault 不持有插件 UI 状态）
        (window as unknown as Record<string, unknown>).__TB_PENDING_NOTE__ = rel;
        window.dispatchEvent(new CustomEvent("tb:open-note", { detail: rel }));
        void openFileRef.current(rel);
      },
      openChecklist: (id: string) => {
        setView("checklist");
        setViewParams({ openChecklistId: id });
      },
    }),
    [view, viewParams]
  );

  return (
    <NavProvider value={navValue}>
      <div className="app">
        <TopBar
          theme={themeMode}
          onToggleTheme={toggleThemeMode}
          query={vault.query}
          onQueryChange={vault.setQuery}
          // 顶栏搜索仅服务于宿主回退笔记视图（已删除）——笔记视图恒为插件
          // 自带前端（内置自己的搜索框），故顶栏搜索恒停用
          searchEnabled={false}
          vaultName={vaultName}
          onPickVault={vault.pickVault}
          navCollapsed={navCollapsed}
          onToggleNav={() => setNavCollapsed((c) => !c)}
          onToggleFloat={() => void floatToggle()}
          focusSignal={focusTick}
        />
        <div className="body">
          <Sidebar
            activeView={view}
            onSelect={(v) => {
              setView(v);
              setViewParams({});
            }}
            collapsed={navCollapsed}
            config={nav}
            defs={navDefs}
            onToggleGroup={toggleNavGroup}
          />
          <main className="main">
            {view === "overview" ? (
              <WelcomeView
                ping={pingInfo}
                themeName={themeName}
                onOpenNotes={() => setView("notes")}
              />
            ) : view === "plugins" ? (
              <PluginsView />
            ) : view === "checklist" ? (
              corePluginEnabled(pluginCtx.plugins, "core-checklists") ? (
                <PluginUiView pluginId="core-checklists" />
              ) : (
                <CoreDisabled name="清单" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : view === "projects" ? (
              corePluginEnabled(pluginCtx.plugins, "core-projects") ? (
                <PluginUiView pluginId="core-projects" />
              ) : (
                <CoreDisabled name="项目" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : view === "ai" ? (
              corePluginEnabled(pluginCtx.plugins, "core-ai") ? (
                <PluginUiView pluginId="core-ai" />
              ) : (
                <CoreDisabled name="AI 整理" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : view === "blog" ? (
              corePluginEnabled(pluginCtx.plugins, "core-blog") ? (
                <PluginUiView pluginId="core-blog" />
              ) : (
                <CoreDisabled name="博客发布" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
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
                <CoreDisabled name="笔记" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : (
              // 未知视图（如第三方插件声明的非内置 nav 项）：明确占位而非静默落笔记视图
              <div className="empty-state">
                <h2>未找到页面</h2>
                <p>该视图不存在或对应插件未启用</p>
              </div>
            )}
          </main>
        </div>
        <StatusBar
          ping={pingInfo}
          theme={themeMode}
          vaultName={vaultName}
          status={vault.status}
        />
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
