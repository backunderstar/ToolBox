import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "toolbox.theme";

/**
 * 主题引擎（M0 简化版）：
 * 1. CSS 变量切换（tokens.css 的 [data-theme]）
 * 2. 原生窗口标题栏跟随（Windows/macOS 的 setTheme）
 * 3. 持久化用户选择
 * M5 里程碑扩展为主题包系统：theme.json + 令牌覆盖 + 主题切换器。
 */
export function getInitialTheme(): ThemeMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** 应用主题：CSS 变量 + 原生标题栏 + 持久化。 */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
  localStorage.setItem(STORAGE_KEY, mode);
  void syncWindowTheme(mode);
}

/** 同步原生窗口标题栏主题（Tauri 环境）；浏览器预览时静默跳过。 */
async function syncWindowTheme(mode: ThemeMode): Promise<void> {
  try {
    await getCurrentWindow().setTheme(mode);
  } catch {
    // 非 Tauri 环境（浏览器预览）：标题栏由系统接管，忽略即可
  }
}
