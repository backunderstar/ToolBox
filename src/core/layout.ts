/**
 * 布局偏好：导航侧栏折叠。
 * 持久化到 localStorage，重启应用后保持。
 * 文件面板折叠/专注模式曾属于宿主回退笔记视图（已删除，见死代码清理），不再记录。
 */

export interface LayoutPrefs {
  navCollapsed: boolean;
}

const KEY = "toolbox.layout";
const DEFAULTS: LayoutPrefs = {
  navCollapsed: false,
};

export function loadLayoutPrefs(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      // 旧版本可能存了 filesCollapsed/focusMode 等字段：合并时被 DEFAULTS 覆盖忽略
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
