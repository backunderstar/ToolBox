// 导航栏偏好：顺序 + 隐藏（localStorage 持久化，纯 UI 配置，无需 Rust 侧）。
//
// 存储结构（`toolbox.nav`）：
//   { order: { 分组标签: [视图id, ...] }, hidden: [视图id, ...] }
//
// 与 `core/layout.ts` 的布局偏好同一类（localStorage 键 `toolbox.*`），
// 换工作区不影响。校验策略：以当前代码里的分组定义为准——未知 id 丢弃、
// 缺失项补回默认顺序尾部，旧版本数据也能安全加载。

export interface NavPrefs {
  /** 隐藏的导航项 id（"settings" 强制可见，normalize 时过滤掉） */
  hidden: string[];
  /** 每个分组内导航项的顺序（分组标签 → id 列表） */
  order: Record<string, string[]>;
}

const KEY = "toolbox.nav";

/** 分组结构的最小形状（Sidebar 的 NAV_GROUPS 满足） */
export interface NavGroupLike {
  label: string;
  items: { id: string }[];
}

/** 以默认顺序为底，把保存的顺序与当前代码定义合并出合法配置。 */
export function normalizeNavPrefs(
  groups: NavGroupLike[],
  raw: unknown
): NavPrefs {
  const valid = new Set(groups.flatMap((g) => g.items.map((i) => i.id)));
  const r = (raw ?? {}) as { order?: Record<string, unknown>; hidden?: unknown };
  const order: Record<string, string[]> = {};
  for (const g of groups) {
    const def = g.items.map((i) => i.id);
    const saved = Array.isArray(r.order?.[g.label])
      ? (r.order[g.label] as unknown[]).filter(
          (id): id is string => typeof id === "string" && valid.has(id)
        )
      : [];
    const seen = new Set(saved);
    // 保存的顺序在前（保持用户调整），当前定义里缺失的按默认顺序补尾
    order[g.label] = [...saved, ...def.filter((id) => !seen.has(id))];
  }
  const hidden = Array.isArray(r.hidden)
    ? (r.hidden as unknown[]).filter(
        (id): id is string =>
          typeof id === "string" && valid.has(id) && id !== "settings"
      )
    : [];
  return { order, hidden };
}

/** 读取并规范化导航偏好；无配置/损坏时返回默认值。 */
export function loadNavPrefs(groups: NavGroupLike[]): NavPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeNavPrefs(groups, raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeNavPrefs(groups, null);
  }
}

export function saveNavPrefs(prefs: NavPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式等场景忽略写入失败 */
  }
}
