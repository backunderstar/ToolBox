import { useEffect, useRef } from "react";
import { IconFloat, IconFolder, IconMoon, IconPanelLeft, IconSun } from "./icons";
import type { ThemeMode } from "../themes/themes";
import { APP_TAG } from "../core/version";
import type { SearchHit } from "../core/api";

interface TopBarProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  query: string;
  onQueryChange: (q: string) => void;
  searchEnabled: boolean;
  /** 全局搜索命中（vault.results；null = 未搜索/已清空） */
  results: SearchHit[] | null;
  /** 搜索进行中 */
  searching: boolean;
  /** 点击搜索结果：打开对应文件 */
  onOpenResult: (path: string) => void;
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
  results,
  searching,
  onOpenResult,
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
          placeholder="全局搜索（文件名 + 内容）"
          value={query}
          disabled={!searchEnabled}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <kbd>Ctrl K</kbd>
        {/* 全局搜索结果下拉：文件名匹配优先；source 标记插件提供者命中 */}
        {searchEnabled && query.trim() && (
          <div className="search-dropdown">
            {searching ? (
              <div className="search-hint">搜索中…</div>
            ) : results === null ? null : results.length === 0 ? (
              <div className="search-hint">无结果</div>
            ) : (
              results.map((r) => (
                <button
                  key={r.path}
                  className="search-item"
                  onClick={() => onOpenResult(r.path)}
                  title={r.snippet}
                >
                  <span className="search-item-name">{r.filename}</span>
                  <span className="search-item-path">{r.path}</span>
                  {r.source && <span className="badge badge-provider">{r.source}</span>}
                </button>
              ))
            )}
          </div>
        )}
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
