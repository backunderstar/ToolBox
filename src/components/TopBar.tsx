import { useEffect, useRef, useState } from "react";
import { IconFloat, IconFolder, IconMoon, IconPanelLeft, IconSun } from "./icons";
import type { ThemeMode } from "../themes/themes";
import { APP_TAG } from "../core/version";
import type { SearchHit } from "../core/api";

/**
 * 顶栏（应用外壳）：导航折叠 / 品牌 / 工作区选择 / 全局搜索（任意视图可用，
 * Ctrl+K 聚焦，↑↓ 选择 Enter 打开 Esc 清空）/ 主题亮暗切换 / 桌面浮窗开关。
 * 搜索下拉的状态与键盘导航全在本组件内（activeIdx + 相对时间 + 计数）。
 */

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

/** 搜索结果下拉最多渲染条数：全文搜索可轻易上百条，全量渲染 DOM 开销大。
 *  截断超出部分并在下拉底部提示（键盘导航边界按可见条数计算，与渲染一致）。 */
const MAX_RESULTS = 50;

/** 相对时间：mtime（UNIX 毫秒）→ "刚刚 / x 分钟前 / x 小时前 / x 天前"。
 *  搜索结果按最近修改排序（D2），展示相对时间让排序依据可见。 */
function formatRelTime(mtime?: number): string {
  if (!mtime || mtime <= 0) return "";
  const diff = Date.now() - mtime;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
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
  /* S1：键盘导航当前选中项（-1 = 无选择）。结果变化时重置。 */
  const [activeIdx, setActiveIdx] = useState(-1);
  useEffect(() => {
    setActiveIdx(-1);
  }, [results]);

  /* Ctrl+K：聚焦搜索框 */
  useEffect(() => {
    if (focusSignal && focusSignal > 0 && searchRef.current) {
      searchRef.current.focus();
      searchRef.current.select();
    }
  }, [focusSignal]);

  return (
    <header className="topbar" data-part="topbar">
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

      <button className="workspace-btn" onClick={onPickVault} title="选择 / 切换工作区文件夹">
        <IconFolder width={13} height={13} />
        <span>{vaultName ?? "选择工作区"}</span>
      </button>

      <div
        className={`search${searchEnabled ? "" : " disabled"}`}
        title={searchEnabled ? "搜索文件名与内容（Ctrl+K 聚焦，↑/↓ 选择，Enter 打开）" : "进入「笔记」并选择工作区后可用"}
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
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIdx((i) =>
                results && results.length
                  ? Math.min(i + 1, Math.min(results.length, MAX_RESULTS) - 1)
                  : -1,
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIdx((i) => Math.max(i - 1, -1));
            } else if (e.key === "Enter") {
              // 有选中项才消费 Enter（否则放行，输入框默认无副作用）
              if (activeIdx >= 0 && results && results[activeIdx]) {
                e.preventDefault();
                onOpenResult(results[activeIdx].path);
              }
            } else if (e.key === "Escape") {
              // 清空 → vault 层 results 置 null，下拉关闭
              onQueryChange("");
            }
          }}
        />
        <kbd>Ctrl K</kbd>
        {/* 全局搜索结果下拉：文件名匹配优先（mtime 降序）；source 标记插件提供者命中 */}
        {searchEnabled && query.trim() && (
          <div className="search-dropdown">
            {searching ? (
              <div className="search-hint">搜索中…</div>
            ) : results === null ? null : results.length === 0 ? (
              <div className="search-hint">无结果</div>
            ) : (
              <>
                {/* 结果截断：全文搜索可轻易上百条，全量渲染会让下拉 DOM 爆炸；
                    截断后保留提示，引导继续输入缩小范围 */}
                {results.slice(0, MAX_RESULTS).map((r, i) => (
                  <button
                    // 同一路径可能多来源（全文命中 + 搜索提供者），key 需含 source 去重
                    key={`${r.source ?? "file"}:${r.path}`}
                    className={`search-item${i === activeIdx ? " active" : ""}`}
                    onClick={() => onOpenResult(r.path)}
                    onMouseEnter={() => setActiveIdx(i)}
                    title={r.snippet}
                  >
                    <span className="search-item-name">{r.filename}</span>
                    <span className="search-item-path">{r.path}</span>
                    {r.mtime ? (
                      <span className="search-item-time">{formatRelTime(r.mtime)}</span>
                    ) : null}
                    {r.source && <span className="badge badge-provider">{r.source}</span>}
                  </button>
                ))}
                <div className="search-meta">
                  {results.length > MAX_RESULTS
                    ? `共 ${results.length} 条，仅显示前 ${MAX_RESULTS} 条（继续输入以缩小范围）`
                    : `共 ${results.length} 条结果`}
                </div>
              </>
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
