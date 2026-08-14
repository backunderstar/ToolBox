import { useEffect, useState } from "react";
import { ping, type PingInfo } from "./core/ipc";
import { applyTheme, getInitialTheme, type ThemeMode } from "./themes/theme";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { WelcomeView } from "./components/WelcomeView";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

export default function App() {
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

  return (
    <div className="app">
      <TopBar theme={theme} onToggleTheme={toggleTheme} />
      <div className="body">
        <Sidebar />
        <main className="main">
          <WelcomeView ping={pingInfo} theme={theme} />
        </main>
      </div>
      <StatusBar ping={pingInfo} theme={theme} />
    </div>
  );
}
