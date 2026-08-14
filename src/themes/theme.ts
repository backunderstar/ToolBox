export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "toolbox.theme";

/**
 * 主题引擎（M0 简化版）：
 * 读取已保存的主题，否则跟随系统偏好。
 * M5 里程碑扩展为主题包系统：theme.json + 令牌覆盖 + 主题切换器。
 */
export function getInitialTheme(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** 应用主题：设置根节点 data-theme 属性（tokens.css 据此切换变量）并持久化。 */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem(STORAGE_KEY, mode);
}
