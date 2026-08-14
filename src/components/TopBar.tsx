import { IconMoon, IconSun } from "./icons";
import type { ThemeMode } from "../themes/theme";

interface TopBarProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
}

export function TopBar({ theme, onToggleTheme }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-title">ToolBox</span>
        <span className="topbar-tag">v0.1.0 · M0</span>
      </div>

      <div className="search" title="M1 里程碑开放全局搜索">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          type="text"
          placeholder="全局搜索（M1 开放）"
          disabled
          aria-disabled="true"
        />
        <kbd>Ctrl K</kbd>
      </div>

      <div className="spacer" />

      <button
        className="icon-btn"
        onClick={onToggleTheme}
        title={theme === "light" ? "切换到暗色" : "切换到亮色"}
        aria-label="切换主题"
      >
        {theme === "light" ? <IconMoon /> : <IconSun />}
      </button>
    </header>
  );
}
