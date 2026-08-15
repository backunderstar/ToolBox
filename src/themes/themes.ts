import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 主题系统（M5）：
 *
 * - 主题包 = 元数据 + 令牌覆盖：`base` 决定亮/暗基础（驱动 tokens.css 的
 *   [data-theme]），`tokens` 覆盖设计令牌（CSS 变量），经 style 注入生效。
 * - 内置 3 个主题（简约亮 / 简约暗 / 暖色）；用户可在设置页复制、调色、保存
 *   自定义主题（localStorage 持久化，v1；后续可落盘 vault/themes/ 成文件包）。
 * - 切换：document.documentElement 的 data-theme（base）与 data-theme-id，
 *   旧版 localStorage 值 "light"/"dark" 自动迁移。
 */

export type ThemeMode = "light" | "dark";

/** 可被主题覆盖的核心令牌（供编辑器选择，实际可覆盖任意 CSS 变量） */
export const EDITABLE_TOKENS: { key: string; label: string }[] = [
  { key: "--bg", label: "画布背景" },
  { key: "--bg-soft", label: "面板背景" },
  { key: "--bg-elevated", label: "卡片背景" },
  { key: "--fg", label: "正文" },
  { key: "--fg-muted", label: "次要文字" },
  { key: "--accent", label: "强调色" },
  { key: "--accent-strong", label: "强调色(深)" },
  { key: "--border", label: "边框" },
  { key: "--border-strong", label: "边框(深)" },
];

export interface ThemeDef {
  id: string;
  name: string;
  base: ThemeMode;
  description: string;
  /** 令牌覆盖（CSS 变量名 → 值）；空对象表示完全使用 base 默认 */
  tokens: Record<string, string>;
  /** 自定义主题标记（内置为 false） */
  custom?: boolean;
}

const STORAGE_KEY = "toolbox.theme";
const CUSTOM_KEY = "toolbox.custom-themes";

/* ---------------- 内置主题 ---------------- */

export const BUILTIN_THEMES: ThemeDef[] = [
  {
    id: "default-light",
    name: "简约亮色",
    base: "light",
    description: "暖骨白画布 · 陶土强调 · 默认主题",
    tokens: {},
  },
  {
    id: "default-dark",
    name: "简约暗色",
    base: "dark",
    description: "墨色画布 · 低对比 · 夜间友好",
    tokens: {},
  },
  {
    id: "warm",
    name: "暖色",
    base: "light",
    description: "奶油米色 · 赭石强调 · 纸张质感",
    tokens: {
      "--bg": "#f4efe6",
      "--bg-soft": "#faf7f0",
      "--bg-elevated": "#fffdf7",
      "--fg": "#2a2418",
      "--fg-muted": "#8a8071",
      "--fg-faint": "#b3a996",
      "--border": "#e6dfcf",
      "--border-strong": "#d3c9b4",
      "--accent": "#a05f2c",
      "--accent-strong": "#7d4518",
      "--accent-soft": "#f0e2d0",
      "--on-accent": "#fffaf2",
      "--pastel-yellow-bg": "#f6ecd2",
      "--pastel-yellow-fg": "#8a6a1f",
      "--pastel-green-bg": "#e9efe2",
      "--pastel-green-fg": "#5c7a3e",
      "--pastel-blue-bg": "#e2edf2",
      "--pastel-blue-fg": "#2f6a86",
      "--pastel-red-bg": "#f8e4df",
      "--pastel-red-fg": "#96422f",
    },
  },
];

/* ---------------- 自定义主题（localStorage） ---------------- */

export function loadCustomThemes(): ThemeDef[] {
  const raw = localStorage.getItem(CUSTOM_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as ThemeDef[];
    return Array.isArray(arr) ? arr.filter((t) => t && t.id && t.name) : [];
  } catch {
    return [];
  }
}

function saveCustomThemes(list: ThemeDef[]): void {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

export function listThemes(): ThemeDef[] {
  return [...BUILTIN_THEMES, ...loadCustomThemes()];
}

export function findTheme(id: string): ThemeDef | undefined {
  return listThemes().find((t) => t.id === id);
}

export function getThemeBase(id: string): ThemeMode {
  return findTheme(id)?.base ?? "light";
}

/** 保存/更新自定义主题（内置主题 id 拒绝覆盖） */
export function upsertCustomTheme(def: ThemeDef): void {
  const list = loadCustomThemes().filter((t) => t.id !== def.id);
  list.push({ ...def, custom: true });
  saveCustomThemes(list);
}

export function deleteCustomTheme(id: string): void {
  saveCustomThemes(loadCustomThemes().filter((t) => t.id !== id));
}

/* ---------------- 引擎 ---------------- */

function overrideStyle(): HTMLStyleElement {
  let el = document.getElementById("theme-overrides") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "theme-overrides";
    document.head.appendChild(el);
  }
  return el;
}

/** 应用主题：base → data-theme（驱动 tokens.css），覆盖令牌注入 style，持久化 */
export function applyTheme(id: string): void {
  const theme = findTheme(id);
  if (!theme) {
    applyTheme("default-light");
    return;
  }
  applyThemeStyle(theme.base, id, theme.tokens);
  localStorage.setItem(STORAGE_KEY, id);
  void syncWindowTheme(theme.base);
}

/** 纯 DOM 应用（预览用，不持久化） */
export function applyThemeStyle(
  base: ThemeMode,
  id: string,
  tokens: Record<string, string>
): void {
  document.documentElement.dataset.theme = base;
  document.documentElement.dataset.themeId = id;
  const entries = Object.entries(tokens);
  if (entries.length === 0) {
    overrideStyle().textContent = "";
  } else {
    const css = entries.map(([k, v]) => `  ${k}: ${v};`).join("\n");
    overrideStyle().textContent = `:root[data-theme-id="${id}"] {\n${css}\n}`;
  }
}

/** 初始主题：读持久化值，兼容旧版 "light"/"dark" */
export function getInitialTheme(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") {
    // 旧值迁移
    return saved === "light" ? "default-light" : "default-dark";
  }
  if (saved && findTheme(saved)) return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "default-dark"
    : "default-light";
}

/** 顶栏切换：在当前主题的 base 与相反 base 的默认主题之间切换 */
export function toggleTheme(currentId: string): string {
  const base = getThemeBase(currentId);
  return base === "light" ? "default-dark" : "default-light";
}

/** 同步原生窗口标题栏主题（Tauri 环境）；浏览器预览时静默跳过 */
async function syncWindowTheme(mode: ThemeMode): Promise<void> {
  try {
    await getCurrentWindow().setTheme(mode);
  } catch {
    /* 非 Tauri 环境（浏览器预览）：标题栏由系统接管，忽略即可 */
  }
}

/** 内置主题的近似色块（用于选择器预览） */
export function swatchOf(theme: ThemeDef): string[] {
  const bg = theme.tokens["--bg"] ?? (theme.base === "dark" ? "#1b1a17" : "#f6f5f2");
  const accent = theme.tokens["--accent"] ?? (theme.base === "dark" ? "#d07a4f" : "#b4532a");
  const fg = theme.tokens["--fg"] ?? (theme.base === "dark" ? "#e9e6df" : "#201f1c");
  return [bg, accent, fg];
}
