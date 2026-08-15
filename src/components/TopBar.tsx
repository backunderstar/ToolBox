import { IconFolder, IconMoon, IconPanelLeft, IconSun } from "./icons";
import type { ThemeMode } from "../themes/themes";

interface TopBarProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  searchEnabled: boolean;
  vaultName: string | null;
  onPickVault: () => void;
  navCollapsed: boolean;
  onToggleNav: () => void;
}

export function TopBar({
  theme,
  onToggleTheme,
  query,
  onQueryChange,
  searchEnabled,
  vaultName,
  onPickVault,
  navCollapsed,
  onToggleNav,
}: TopBarProps) {
  return (
    <header className="topbar">
      <button
        className="icon-btn"
        onClick={onToggleNav}
        title={navCollapsed ? "展开导航侧栏" : "收起导航侧栏"}
        aria-label="切换导航侧栏"
      >
        <IconPanelLeft width={15} height={15} />
      </button>

      <div className="topbar-brand">
        <span className="topbar-title">ToolBox</span>
        <span className="topbar-tag">v0.1.0 · M5</span>
      </div>

      <button
        className="workspace-btn"
        onClick={onPickVault}
        title="选择 / 切换工作区文件夹"
      >
        <IconFolder width={13} height={13} />
        <span>{vaultName ?? "选择工作区"}</span>
      </button>

      <div
        className={`search${searchEnabled ? "" : " disabled"}`}
        title={
          searchEnabled
            ? "搜索文件名与笔记内容"
            : "进入「笔记」并选择工作区后可用"
        }
      >
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
          placeholder="搜索笔记（文件名 + 内容）"
          value={query}
          disabled={!searchEnabled}
          onChange={(e) => onQueryChange(e.target.value)}
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
