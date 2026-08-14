/**
 * 布局偏好：导航侧栏折叠 / 文件面板折叠 / 专注模式。
 * 持久化到 localStorage，重启应用后保持。
 */

export interface LayoutPrefs {
  navCollapsed: boolean;
  filesCollapsed: boolean;
  focusMode: boolean;
}

const KEY = "toolbox.layout";
const DEFAULTS: LayoutPrefs = {
  navCollapsed: false,
  filesCollapsed: false,
  focusMode: false,
};

export function loadLayoutPrefs(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<LayoutPrefs>) };
    }
  } catch {
    /* 忽略损坏数据 */
  }
  return { ...DEFAULTS };
}

export function saveLayoutPrefs(prefs: LayoutPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* 忽略 */
  }
}
