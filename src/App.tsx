import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ping, type PingInfo } from "./core/ipc";
import { VaultProvider, useVault } from "./core/vault";
import { PluginProvider, usePlugins } from "./core/plugins";
import { ChecklistProvider } from "./core/checklists";
import { RecordsProvider } from "./core/records";
import { ProjectsProvider } from "./core/projects";
import { NavProvider } from "./core/navigation";
import type { ViewParams } from "./core/navigation";
import { loadLayoutPrefs, saveLayoutPrefs } from "./core/layout";
import { loadNavPrefs, saveNavPrefs, type NavPrefs } from "./core/navPrefs";
import { floatToggle } from "./core/api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, getInitialTheme, toggleTheme, getThemeBase, findTheme } from "./themes/themes";
import { TopBar } from "./components/TopBar";
import { Sidebar, NAV_GROUPS, type ViewId } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { WelcomeView } from "./components/WelcomeView";
import { NotesView } from "./components/NotesView";
import { PluginsView } from "./components/PluginsView";
import { ToolsView } from "./components/ToolsView";
import { ChecklistView } from "./components/ChecklistView";
import { RecordsView } from "./components/RecordsView";
import { ProjectsView } from "./components/ProjectsView";
import { AIChatView } from "./components/AIChatView";
import { BlogView } from "./components/BlogView";
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
          <ChecklistProvider>
            <RecordsProvider>
              <ProjectsProvider>
                <AppInner />
              </ProjectsProvider>
            </RecordsProvider>
          </ChecklistProvider>
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

  /* 布局偏好：导航折叠 / 文件面板折叠 / 专注模式（持久化） */
  const [navCollapsed, setNavCollapsed] = useState(
    () => loadLayoutPrefs().navCollapsed
  );
  const [filesCollapsed, setFilesCollapsed] = useState(
    () => loadLayoutPrefs().filesCollapsed
  );
  const [focusMode, setFocusMode] = useState(
    () => loadLayoutPrefs().focusMode
  );

  /* 导航栏偏好：顺序 + 隐藏（localStorage 持久化） */
  const [navPrefs, setNavPrefs] = useState<NavPrefs>(() =>
    loadNavPrefs(NAV_GROUPS)
  );

  useEffect(() => {
    saveLayoutPrefs({ navCollapsed, filesCollapsed, focusMode });
  }, [navCollapsed, filesCollapsed, focusMode]);

  useEffect(() => {
    saveNavPrefs(navPrefs);
  }, [navPrefs]);

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

  /* 专注模式：导航与文件面板全部隐藏，编辑器占满 */
  const navHidden = focusMode;

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
      openRecord: (id: string) => {
        setView("records");
        setViewParams({ openRecordId: id });
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
          // 笔记视图为插件自带前端时，顶栏搜索停用（插件界面内有自己的搜索框）
          searchEnabled={
            view === "notes" && !!vault.path && !hasPluginUi(pluginCtx.plugins, "core-notes")
          }
          vaultName={vaultName}
          onPickVault={vault.pickVault}
          navCollapsed={navCollapsed}
          onToggleNav={() => setNavCollapsed((c) => !c)}
          onToggleFloat={() => void floatToggle()}
          focusSignal={focusTick}
        />
        <div className="body">
          {!navHidden && (
            <Sidebar
              activeView={view}
              onSelect={(v) => {
                setView(v);
                setViewParams({});
              }}
              collapsed={navCollapsed}
              prefs={navPrefs}
              pluginNav={pluginCtx.navItems}
            />
          )}
          <main className="main">
            {view === "overview" ? (
              <WelcomeView
                ping={pingInfo}
                themeName={themeName}
                onOpenNotes={() => setView("notes")}
              />
            ) : view === "plugins" ? (
              <PluginsView />
            ) : view === "tools" ? (
              <ToolsView />
            ) : view === "checklist" ? (
              corePluginEnabled(pluginCtx.plugins, "core-checklists") ? (
                hasPluginUi(pluginCtx.plugins, "core-checklists") ? (
                  <PluginUiView pluginId="core-checklists" />
                ) : (
                  <ChecklistView />
                )
              ) : (
                <CoreDisabled name="清单" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : view === "records" ? (
              corePluginEnabled(pluginCtx.plugins, "core-records") ? (
                hasPluginUi(pluginCtx.plugins, "core-records") ? (
                  <PluginUiView pluginId="core-records" />
                ) : (
                  <RecordsView />
                )
              ) : (
                <CoreDisabled name="记录" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : view === "projects" ? (
              corePluginEnabled(pluginCtx.plugins, "core-projects") ? (
                hasPluginUi(pluginCtx.plugins, "core-projects") ? (
                  <PluginUiView pluginId="core-projects" />
                ) : (
                  <ProjectsView />
                )
              ) : (
                <CoreDisabled name="项目" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : view === "ai" ? (
              corePluginEnabled(pluginCtx.plugins, "core-ai") ? (
                hasPluginUi(pluginCtx.plugins, "core-ai") ? (
                  <PluginUiView pluginId="core-ai" />
                ) : (
                  <AIChatView />
                )
              ) : (
                <CoreDisabled name="AI 整理" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : view === "blog" ? (
              corePluginEnabled(pluginCtx.plugins, "core-blog") ? (
                hasPluginUi(pluginCtx.plugins, "core-blog") ? (
                  <PluginUiView pluginId="core-blog" />
                ) : (
                  <BlogView />
                )
              ) : (
                <CoreDisabled name="博客发布" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : view === "settings" ? (
              <SettingsView
                themeId={themeId}
                onSetThemeId={setThemeId}
                ping={pingInfo}
                navPrefs={navPrefs}
                onNavPrefsChange={setNavPrefs}
              />
            ) : view === "notes" ? (
              corePluginEnabled(pluginCtx.plugins, "core-notes") ? (
                hasPluginUi(pluginCtx.plugins, "core-notes") ? (
                  <PluginUiView pluginId="core-notes" />
                ) : (
                  <NotesView
                    dark={themeMode === "dark"}
                    filesCollapsed={filesCollapsed}
                    focusMode={focusMode}
                    onToggleFiles={() => setFilesCollapsed((c) => !c)}
                    onToggleFocus={() => setFocusMode((f) => !f)}
                  />
                )
              ) : (
                <CoreDisabled name="笔记" onGoPlugins={() => { setView("plugins"); setViewParams({}); }} />
              )
            ) : (
              <NotesView
                dark={themeMode === "dark"}
                filesCollapsed={filesCollapsed}
                focusMode={focusMode}
                onToggleFiles={() => setFilesCollapsed((c) => !c)}
                onToggleFocus={() => setFocusMode((f) => !f)}
              />
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

/** 插件是否自带前端（声明 ui → 用 PluginUiView 渲染插件页面）。 */
function hasPluginUi(plugins: { id: string; ui: string | null }[], id: string): boolean {
  const p = plugins.find((x) => x.id === id);
  return !!p?.ui;
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
