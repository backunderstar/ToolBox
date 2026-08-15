import { useEffect, useRef } from "react";
import { IconFloat, IconFolder, IconMoon, IconPanelLeft, IconSun } from "./icons";
import type { ThemeMode } from "../themes/themes";
import { APP_TAG } from "../core/version";

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
  /** 显示 / 隐藏桌面浮窗（快速待办） */
  onToggleFloat: () => void;
  /** Ctrl+K 快捷键聚焦信号（App 层自增触发） */
  focusSignal?: number;
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
  onToggleFloat,
  focusSignal,
}: TopBarProps) {
  const searchRef = useRef<HTMLInputElement | null>(null);

  /* Ctrl+K：聚焦搜索框 */
  useEffect(() => {
    if (focusSignal && focusSignal > 0 && searchRef.current) {
      searchRef.current.focus();
      searchRef.current.select();
    }
  }, [focusSignal]);
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
        <span className="topbar-tag">{APP_TAG}</span>
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
          ref={searchRef}
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
        onClick={onToggleFloat}
        title="显示 / 隐藏桌面浮窗（快速待办）"
        aria-label="切换浮窗"
      >
        <IconFloat width={15} height={15} />
      </button>

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
