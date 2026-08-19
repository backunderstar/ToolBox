import { describe, expect, it } from "vitest";
import { BUILTIN_GROUPS, groupIdFor, normalizeNav } from "./navPrefs";
import type { NavConfig, NavItemDef } from "./navPrefs";

const DEFS: NavItemDef[] = [
  { id: "overview", label: "概览", icon: "grid", groupId: "work" },
  { id: "plugins", label: "插件", icon: "puzzle", groupId: "system" },
  { id: "settings", label: "设置", icon: "gear", groupId: "system", fixed: true },
  { id: "todo", label: "待办", icon: "check", groupId: "work" },
];

function baseCfg(order: Record<string, string[]>): NavConfig {
  return {
    version: 2,
    groups: BUILTIN_GROUPS.map((g) => ({ ...g })),
    order,
    meta: {},
  };
}

describe("groupIdFor", () => {
  it("内置组 label 归入内置组 id", () => {
    expect(groupIdFor("工作区")).toBe("work");
    expect(groupIdFor("系统")).toBe("system");
  });
  it("未知 label 生成动态组", () => {
    expect(groupIdFor("我的组")).toBe("dyn:我的组");
  });
});

describe("normalizeNav", () => {
  it("null 配置按代码定义重建默认", () => {
    const nav = normalizeNav(null, DEFS);
    expect(nav.version).toBe(2);
    expect(nav.groups.map((g) => g.id)).toEqual(["work", "system"]);
    expect(nav.order.work).toEqual(["overview", "todo"]);
    expect(nav.order.system).toEqual(["plugins", "settings"]);
  });

  it("保留用户顺序，未配置项补默认组尾部", () => {
    const nav = normalizeNav(baseCfg({ work: ["todo"], system: ["settings"] }), DEFS);
    expect(nav.order.work).toEqual(["todo", "overview"]);
    expect(nav.order.system).toEqual(["settings", "plugins"]);
  });

  it("自定义组改名生效（ensureGroup 覆盖 label）", () => {
    const cfg: NavConfig = {
      ...baseCfg({ work: ["overview"], system: ["settings"] }),
      groups: [
        { id: "work", label: "我的工作" },
        { id: "system", label: "系统" },
      ],
    };
    const nav = normalizeNav(cfg, DEFS);
    expect(nav.groups.find((g) => g.id === "work")?.label).toBe("我的工作");
  });

  it("settings 强制可见（hidden 被剥离）", () => {
    const cfg: NavConfig = {
      ...baseCfg({ work: [], system: [] }),
      meta: { settings: { hidden: true } },
    };
    const nav = normalizeNav(cfg, DEFS);
    expect(nav.meta.settings?.hidden).toBeUndefined();
  });

  it("动态组无项时清除，内置/用户组保留", () => {
    const cfg: NavConfig = {
      version: 2,
      groups: [
        ...BUILTIN_GROUPS.map((g) => ({ ...g })),
        { id: "dyn:废弃", label: "废弃" },
        { id: "user:my", label: "我的组" },
      ],
      order: { work: ["overview"], system: ["settings"], "dyn:废弃": [], "user:my": [] },
      meta: {},
    };
    const nav = normalizeNav(cfg, DEFS);
    expect(nav.groups.some((g) => g.id === "dyn:废弃")).toBe(false);
    expect(nav.groups.some((g) => g.id === "user:my")).toBe(true);
  });

  it("一次迁移：work 含 plugins 时移到 system，且幂等", () => {
    const cfg = baseCfg({ work: ["overview", "plugins"], system: ["settings"] });
    const nav = normalizeNav(cfg, DEFS);
    expect(nav.order.work).not.toContain("plugins");
    expect(nav.order.system).toContain("plugins");
    expect(nav.meta.plugins?.movedToSystem).toBe(true);
    const again = normalizeNav(nav, DEFS);
    expect(again.order.system).toContain("plugins");
    expect(again.meta.plugins?.movedToSystem).toBe(true);
  });

  it("损坏结构（groups 非数组）兜底不抛错", () => {
    const bad = { version: 2, groups: { work: [] }, order: {}, meta: {} } as unknown as NavConfig;
    const nav = normalizeNav(bad, DEFS);
    expect(nav.groups.length).toBeGreaterThan(0);
  });
});
