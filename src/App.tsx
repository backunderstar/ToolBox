import { useEffect, useState } from "react";
import { ping, type PingInfo } from "./core/ipc";
import { VaultProvider, useVault } from "./core/vault";
import { PluginProvider } from "./core/plugins";
import { loadLayoutPrefs, saveLayoutPrefs } from "./core/layout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { applyTheme, getInitialTheme, type ThemeMode } from "./themes/theme";
import { TopBar } from "./components/TopBar";
import { Sidebar, type ViewId } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { WelcomeView } from "./components/WelcomeView";
import { NotesView } from "./components/NotesView";
import { PluginsView } from "./components/PluginsView";
import { SettingsView } from "./components/SettingsView";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

export default function App() {
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
  const [view, setView] = useState<ViewId>(() =>
    new URLSearchParams(window.location.search).has("mock") ? "notes" : "overview"
  );
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [pingInfo, setPingInfo] = useState<PingInfo | null>(null);

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

  useEffect(() => {
    saveLayoutPrefs({ navCollapsed, filesCollapsed, focusMode });
  }, [navCollapsed, filesCollapsed, focusMode]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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

  const toggleTheme = () =>
    setTheme((t) => (t === "light" ? "dark" : "light"));

  const vaultName = vault.path
    ? (vault.path.split(/[\\/]/).pop() ?? vault.path)
    : null;

  /* 专注模式：导航与文件面板全部隐藏，编辑器占满 */
  const navHidden = focusMode;

  return (
    <div className="app">
      <TopBar
        theme={theme}
        onToggleTheme={toggleTheme}
        query={vault.query}
        onQueryChange={vault.setQuery}
        searchEnabled={view === "notes" && !!vault.path}
        vaultName={vaultName}
        onPickVault={vault.pickVault}
        navCollapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((c) => !c)}
      />
      <div className="body">
        {!navHidden && (
          <Sidebar
            activeView={view}
            onSelect={setView}
            collapsed={navCollapsed}
          />
        )}
        <main className="main">
          {view === "overview" ? (
            <WelcomeView
              ping={pingInfo}
              theme={theme}
              onOpenNotes={() => setView("notes")}
            />
          ) : view === "plugins" ? (
            <PluginsView />
          ) : view === "settings" ? (
            <SettingsView
              theme={theme}
              onSetTheme={setTheme}
              ping={pingInfo}
            />
          ) : (
            <NotesView
              dark={theme === "dark"}
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
        theme={theme}
        vaultName={vaultName}
        status={vault.status}
      />
    </div>
  );
}
