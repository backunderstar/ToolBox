import { getCurrentWindow } from "@tauri-apps/api/window";
import { pluginsReadFile, setWindowCaptionColor } from "../core/api";

/**
 * 主题系统（M5）：
 *
 * - 主题包 = 元数据 + 令牌覆盖：`base` 决定亮/暗基础（驱动 tokens.css 的
 *   [data-theme]），`tokens` 覆盖设计令牌（CSS 变量），经 style 注入生效。
 * - 内置 3 个主题（简约亮 / 简约暗 / 暖色）；用户可在设置页复制、调色、保存
 *   自定义主题（localStorage 持久化，v1；后续可落盘 vault/themes/ 成文件包）。
 * - **插件主题（皮肤插件）**：插件 manifest 声明 `theme`（base + tokens +
 *   可选 css 文件），由 PluginProvider 把启用插件投影到本模块注册表
 *   （setPluginThemes）；应用时走"令牌 + CSS 双通道"——tokens 与内置同机制，
 *   css 文件经 plugins_read_file 读取后全局注入（`#theme-plugin-css`），
 *   切换主题即移除。纯数据皮肤，无需任何运行时代码。
 * - 切换：document.documentElement 的 data-theme（base）与 data-theme-id，
 *   旧版 localStorage 值 "light"/"dark" 自动迁移。
 */

export type ThemeMode = "light" | "dark";

/** 主题来源：builtin 内置 / custom 用户自定义（localStorage）/ plugin 皮肤插件 */
export type ThemeSource = "builtin" | "custom" | "plugin";

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
  /** 主题来源：插件主题（皮肤插件）为 "plugin"，用户自定义为 "custom" */
  source?: ThemeSource;
  /** 插件主题：来源插件 id（css 文件读取用） */
  pluginId?: string;
  /** 插件主题：可选 CSS 覆盖文件（相对插件目录） */
  css?: string | null;
  /** 预览色板（bg/accent/fg 三色，选择器色块用）；缺省从 tokens 推断 */
  preview?: string[];
}

const STORAGE_KEY = "toolbox.theme";
const CUSTOM_KEY = "toolbox.custom-themes";

/* ---------------- 插件主题注册表（皮肤插件） ---------------- */

/**
 * 模块级插件主题注册表：PluginProvider 在插件状态变化时投影（setPluginThemes）。
 * 用模块级数组而非 React 状态——主题引擎（applyTheme/listThemes）是纯函数
 * 模块，不依赖组件树；注册表只缓存"当前启用插件"的主题定义。
 */
let pluginThemeRegistry: ThemeDef[] = [];

/** 由 PluginProvider 调用：把启用皮肤插件的主题定义投影进注册表 */
export function setPluginThemes(list: ThemeDef[]): void {
  pluginThemeRegistry = list;
}

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
  return [...BUILTIN_THEMES, ...pluginThemeRegistry, ...loadCustomThemes()];
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
  list.push({ ...def, custom: true, source: "custom" });
  saveCustomThemes(list);
}

export function deleteCustomTheme(id: string): void {
  saveCustomThemes(loadCustomThemes().filter((t) => t.id !== id));
}

/** 导出全部自定义主题为 JSON 文本（备份 / 换机迁移 / 分享） */
export function exportThemesJson(): string {
  return JSON.stringify(loadCustomThemes(), null, 2);
}

/** 导入主题 JSON：逐条校验后追加/更新自定义主题，返回成功导入个数。
 *  格式错误（非数组 / 缺 id、name、base）抛错或跳过。 */
export function importThemesJson(raw: string): number {
  const arr = JSON.parse(raw) as unknown;
  if (!Array.isArray(arr)) throw new Error("格式错误：应为主题数组");
  let n = 0;
  for (const t of arr) {
    const d = t as Partial<ThemeDef>;
    if (!d || typeof d.id !== "string" || !d.id || typeof d.name !== "string") continue;
    if (d.base !== "light" && d.base !== "dark") continue;
    const tokens =
      d.tokens && typeof d.tokens === "object" && !Array.isArray(d.tokens)
        ? (d.tokens as Record<string, string>)
        : {};
    upsertCustomTheme({
      id: d.id,
      name: d.name,
      base: d.base,
      description: typeof d.description === "string" ? d.description : "",
      tokens,
      custom: true,
    });
    n++;
  }
  return n;
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

/** 插件主题 CSS 注入节点 id（全局注入，切换主题即移除） */
const PLUGIN_CSS_ID = "theme-plugin-css";

/** 读取并注入皮肤插件的 CSS 覆盖文件（全局 <style>，切走即失效）。
 *  themeId 用于竞态防护：读取期间用户已切换主题则丢弃本次结果。 */
async function loadPluginCss(pluginId: string, rel: string, themeId: string): Promise<void> {
  let css: string;
  try {
    css = await pluginsReadFile(pluginId, rel);
  } catch (e) {
    // CSS 可选：文件缺失/读取失败不阻断令牌通道
    console.warn(`[theme] 插件主题 CSS 加载失败（${pluginId}/${rel}）`, e);
    // 竞态防护（与成功路径对称）：仅当仍是当前主题时才移除节点，否则可能
    // 误删已切换到的另一主题刚注入成功的 CSS 覆盖层（挂起的旧调用失败回落）
    if (document.documentElement.dataset.themeId === themeId) {
      document.getElementById(PLUGIN_CSS_ID)?.remove();
    }
    return;
  }
  // 竞态防护：await 期间用户可能已切走主题，此时丢弃（避免旧主题覆盖新主题）
  if (document.documentElement.dataset.themeId !== themeId) return;
  let el = document.getElementById(PLUGIN_CSS_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = PLUGIN_CSS_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function clearPluginCss(): void {
  document.getElementById(PLUGIN_CSS_ID)?.remove();
}

/** 应用主题：base → data-theme（驱动 tokens.css），覆盖令牌注入 style，持久化。
 *  插件主题额外异步读取并注入 css 覆盖文件（双通道）；调用方无需 await。 */
export async function applyTheme(id: string): Promise<void> {
  const theme = findTheme(id);
  if (!theme) {
    // 主题暂不可用（插件主题尚未加载 / 插件被禁用）：应用默认外观但
    // **不覆盖持久化值**——避免启动瞬间插件未就绪时把用户的选择冲掉
    applyThemeStyle("light", "default-light", {});
    clearPluginCss();
    syncCaptionColor(); // 标题栏回到默认（浅色）画布色
    return;
  }
  applyThemeStyle(theme.base, id, theme.tokens);
  if (theme.source === "plugin" && theme.css && theme.pluginId) {
    await loadPluginCss(theme.pluginId, theme.css, id);
  } else {
    clearPluginCss();
  }
  // 竞态防护（与 loadPluginCss 同源）：await 期间用户可能已切走主题（含
  // 插件禁用触发的自动回落）——此时**丢弃本次的持久化**，否则挂起的旧调用
  // 恢复执行会把 localStorage 又写回旧主题 id（界面已切换，值却倒退）。
  if (document.documentElement.dataset.themeId !== id) return;
  localStorage.setItem(STORAGE_KEY, id);
  void syncWindowTheme(theme.base);
  // 标题栏近似色跟随主题画布背景（Windows 11 原生标题栏；失败静默）
  syncCaptionColor();
}

/** 纯 DOM 应用（预览用，不持久化） */
export function applyThemeStyle(base: ThemeMode, id: string, tokens: Record<string, string>): void {
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

/** 窗口标题栏近似色（主题联动）：把画布背景色（--bg 计算值）同步给原生
 *  标题栏，让外框颜色跟随主题大致色相（暖色 → 米色、午夜蓝 → 深蓝）。
 *  仅支持 #RRGGBB（内置/示例主题都是）；否则恢复系统默认。非 Windows
 *  平台与调用失败都静默（标题栏仍按亮/暗模式渲染，不劣化）。 */
function syncCaptionColor(): void {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  const color = /^#[0-9a-f]{6}$/i.test(bg) ? bg : null;
  setWindowCaptionColor(color).catch(() => undefined);
}

/** 内置主题的近似色块（用于选择器预览）。插件主题优先用声明的 preview 色板
 * （真实意图色），不足 3 色补默认底色；其余按 tokens 推断（--bg/--accent/--fg）。 */
export function swatchOf(theme: ThemeDef): string[] {
  if (theme.preview && theme.preview.length > 0) {
    const p = theme.preview.slice(0, 3);
    while (p.length < 3) p.push(theme.base === "dark" ? "#1b1a17" : "#f6f5f2");
    return p;
  }
  const bg = theme.tokens["--bg"] ?? (theme.base === "dark" ? "#1b1a17" : "#f6f5f2");
  const accent = theme.tokens["--accent"] ?? (theme.base === "dark" ? "#d07a4f" : "#b4532a");
  const fg = theme.tokens["--fg"] ?? (theme.base === "dark" ? "#e9e6df" : "#201f1c");
  return [bg, accent, fg];
}
