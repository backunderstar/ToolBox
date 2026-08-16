// 导航栏全配置（localStorage 持久化，纯 UI 配置，无需 Rust 侧）。
//
// 存储结构（`toolbox.nav`，版本 2）：
//   { version: 2,
//     groups: [{ id, label, collapsed? }...],      // 分组（内置 + 自定义 + 插件动态组）
//     order: { 组id: [项id, ...] },                // 每组的项顺序（含插件项，可任意跨组移动）
//     meta:  { 项id: { label?, icon?, hidden? } }  // 项元数据覆盖（标签/图标/隐藏，插件项也可覆盖）}
//
// 规则：
// - 内置组 id 固定（work 工作区 / system 系统），label 不可改；
//   自定义组 id 用时间戳，可改名；插件声明的 group（label 字符串）匹配内置组 label
//   归入内置组，否则自动建动态组（dyn:<group>）。
// - normalizeNav 以当前代码的项定义（静态 + 插件 nav）为底：
//   失效项清理、未配置项补回默认组尾部、settings 强制可见、空自定义组清除。
// - 插件增删时：新增项自动入默认组、删除项自动清理（存储随之自愈）。

export interface NavItemMeta {
  /** 覆盖默认标签（插件项/内置项均可） */
  label?: string;
  /** 覆盖默认图标（内置图标名，见 Sidebar ICON_MAP） */
  icon?: string;
  /** 隐藏（"settings" 强制可见） */
  hidden?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  /** 侧边栏分组折叠（记忆） */
  collapsed?: boolean;
}

export interface NavConfig {
  version: 2;
  groups: NavGroup[];
  /** 组 id → 有序项 id 列表 */
  order: Record<string, string[]>;
  meta: Record<string, NavItemMeta>;
}

/** 内置组（label 固定；插件声明 group 按 label 匹配归入） */
export const BUILTIN_GROUPS: { id: string; label: string }[] = [
  { id: "work", label: "工作区" },
  { id: "system", label: "系统" },
];

/** 导航项定义（渲染底表：静态项 + 插件 nav 声明） */
export interface NavItemDef {
  id: string;
  label: string;
  /** 图标名（Sidebar ICON_MAP 的 key） */
  icon: string;
  /** 默认归属组 id */
  groupId: string;
  /** 固定显示（settings） */
  fixed?: boolean;
}

/** 插件声明 group（label 字符串）→ 组 id：匹配内置组 label 归入内置组，否则动态组 */
export function groupIdFor(groupLabel: string): string {
  const m = BUILTIN_GROUPS.find((g) => g.label === groupLabel);
  return m ? m.id : `dyn:${groupLabel}`;
}

const KEY = "toolbox.nav";
const VERSION = 2;

/** 以当前项定义为底，把用户配置归一化为合法配置（渲染与持久化统一入口）。 */
export function normalizeNav(cfg: NavConfig | null, defs: NavItemDef[]): NavConfig {
  const groups: NavGroup[] = [];
  const groupById = new Map<string, NavGroup>();
  const ensureGroup = (id: string, label: string) => {
    if (!groupById.has(id)) {
      const g: NavGroup = { id, label };
      groupById.set(id, g);
      groups.push(g);
    }
  };

  // 1. 内置组（始终存在）
  for (const g of BUILTIN_GROUPS) ensureGroup(g.id, g.label);

  // 2. 用户配置的组（自定义组保留改名；内置组 label 固定）
  const raw = cfg?.groups ?? [];
  for (const g of raw) {
    const builtin = BUILTIN_GROUPS.find((b) => b.id === g.id);
    if (builtin) {
      ensureGroup(g.id, builtin.label);
      if (g.collapsed) groupById.get(g.id)!.collapsed = true;
    } else {
      ensureGroup(g.id, g.label || g.id);
      if (g.collapsed) groupById.get(g.id)!.collapsed = true;
    }
  }

  // 3. 项默认组里出现的组（插件动态组）自动建立
  for (const d of defs) {
    if (!groupById.has(d.groupId)) {
      const label = d.groupId.startsWith("dyn:") ? d.groupId.slice(4) : d.groupId;
      ensureGroup(d.groupId, label);
    }
  }

  // 4. 项归属：用户 order 优先，未配置的按默认组补尾。
  //    失效项（插件已禁用的 nav 项）**保留在 order 里**——渲染时按 defById 忽略，
  //    插件重新启用后回到用户配置的位置；"恢复默认"才彻底清空。
  const order: Record<string, string[]> = {};
  const placed = new Set<string>();
  const rawOrder = cfg?.order ?? {};
  for (const g of groups) {
    const saved = Array.isArray(rawOrder[g.id])
      ? (rawOrder[g.id] as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    saved.forEach((id) => placed.add(id));
    order[g.id] = saved;
  }
  for (const d of defs) {
    if (placed.has(d.id)) continue;
    const list = order[d.groupId] ?? (order[d.groupId] = []);
    if (!list.includes(d.id)) list.push(d.id);
  }

  // 5. meta：保留全部（含失效项，供插件重新启用后恢复标签/图标/隐藏）；settings 强制可见
  const meta: Record<string, NavItemMeta> = {};
  for (const [id, m] of Object.entries(cfg?.meta ?? {})) {
    const copy: NavItemMeta = { ...m };
    if (id === "settings") delete copy.hidden;
    if (Object.keys(copy).length > 0) meta[id] = copy;
  }

  // 6. 清理空组：内置组始终保留；user: 组（用户显式新建）保留空组；
  //    dyn: 动态组无项则清除（插件再声明会自动重建）
  const finalGroups = groups.filter(
    (g) =>
      BUILTIN_GROUPS.some((b) => b.id === g.id) ||
      g.id.startsWith("user:") ||
      (order[g.id] ?? []).length > 0
  );
  const finalOrder: Record<string, string[]> = {};
  for (const g of finalGroups) finalOrder[g.id] = order[g.id] ?? [];
  return { version: VERSION, groups: finalGroups, order: finalOrder, meta };
}

/** 旧版格式（v1：{ order: {分组label: [...]}, hidden: [...] }）→ v2 配置 */
function migrateV1(raw: { order?: Record<string, unknown>; hidden?: unknown }): NavConfig {
  const byLabel = new Map(BUILTIN_GROUPS.map((g) => [g.label, g.id]));
  const groups: NavGroup[] = BUILTIN_GROUPS.map((g) => ({ id: g.id, label: g.label }));
  const order: Record<string, string[]> = {};
  for (const [label, list] of Object.entries(raw.order ?? {})) {
    const gid = byLabel.get(label);
    if (gid && Array.isArray(list)) {
      order[gid] = (list as unknown[]).filter((x): x is string => typeof x === "string");
    }
  }
  const meta: Record<string, NavItemMeta> = {};
  if (Array.isArray(raw.hidden)) {
    for (const id of raw.hidden as unknown[]) {
      if (typeof id === "string" && id !== "settings") meta[id] = { hidden: true };
    }
  }
  return { version: VERSION, groups, order, meta };
}

/** 读取导航配置（含旧版 v1 迁移）；损坏时返回 null 交给 normalize 兜底 */
export function loadNavConfig(): NavConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version === VERSION) return parsed as NavConfig;
    if (parsed && typeof parsed === "object" && "order" in parsed) return migrateV1(parsed);
    return null;
  } catch {
    return null;
  }
}

export function saveNavConfig(cfg: NavConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* 隐私模式等场景忽略写入失败 */
  }
}
