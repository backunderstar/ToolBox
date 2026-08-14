import { useEffect, useState } from "react";
import { ping, type PingInfo } from "./core/ipc";
import { VaultProvider, useVault } from "./core/vault";
import { applyTheme, getInitialTheme, type ThemeMode } from "./themes/theme";
import { TopBar } from "./components/TopBar";
import { Sidebar, type ViewId } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { WelcomeView } from "./components/WelcomeView";
import { NotesView } from "./components/NotesView";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

export default function App() {
  return (
    <VaultProvider>
      <AppInner />
    </VaultProvider>
  );
}

function AppInner() {
  const vault = useVault();
  const [view, setView] = useState<ViewId>("overview");
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [pingInfo, setPingInfo] = useState<PingInfo | null>(null);

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
      />
      <div className="body">
        <Sidebar activeView={view} onSelect={setView} />
        <main className="main">
          {view === "overview" ? (
            <WelcomeView
              ping={pingInfo}
              theme={theme}
              onOpenNotes={() => setView("notes")}
            />
          ) : (
            <NotesView dark={theme === "dark"} />
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
