import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_THEMES,
  deleteCustomTheme,
  exportThemesJson,
  findTheme,
  getThemeBase,
  getInitialTheme,
  importThemesJson,
  swatchOf,
  toggleTheme,
  upsertCustomTheme,
  type ThemeDef,
} from "./themes";

/* themes.ts 的纯逻辑部分（引擎/DOM 相关如 applyTheme 不测，需 WebView 环境）。
   依赖的 localStorage / window.matchMedia 在此 mock。 */

const store = new Map<string, string>();

function stubBrowser() {
  store.clear();
  const storage: Storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
}

beforeEach(stubBrowser);

describe("findTheme / getThemeBase", () => {
  it("内置主题可查", () => {
    expect(findTheme("default-light")?.name).toBe("简约亮色");
    expect(findTheme("warm")?.tokens["--accent"]).toBe("#a05f2c");
  });
  it("未知 id 回落 light", () => {
    expect(getThemeBase("no-such")).toBe("light");
    expect(findTheme("no-such")).toBeUndefined();
  });
  it("内置 id 拒绝覆盖（upsert 不落盘，find 仍是内置）", () => {
    upsertCustomTheme({
      id: "warm",
      name: "我的暖色",
      base: "dark",
      description: "",
      tokens: { "--accent": "#000000" },
      custom: true,
    });
    const t = findTheme("warm");
    expect(t?.name).toBe("暖色");
    expect(t?.base).toBe("light");
    expect(loadThemes().some((x) => x.id === "warm")).toBe(false);
  });
});

describe("toggleTheme", () => {
  it("亮 → 暗、暗 → 亮（按 base 取对侧默认）", () => {
    expect(toggleTheme("default-light")).toBe("default-dark");
    expect(toggleTheme("default-dark")).toBe("default-light");
    // warm 是 light base → 切到暗色默认
    expect(toggleTheme("warm")).toBe("default-dark");
  });
});

describe("swatchOf", () => {
  it("内置主题按 tokens/默认推断三色", () => {
    const [bg, accent, fg] = swatchOf(BUILTIN_THEMES[0]); // 简约亮色
    expect(bg).toMatch(/^#/);
    expect(accent).toMatch(/^#/);
    expect(fg).toMatch(/^#/);
  });
  it("preview 不足 3 色时补默认底色", () => {
    const t: ThemeDef = {
      id: "x",
      name: "x",
      base: "dark",
      description: "",
      tokens: {},
      preview: ["#123456"],
      source: "plugin",
    };
    const p = swatchOf(t);
    expect(p).toHaveLength(3);
    expect(p[0]).toBe("#123456");
  });
});

describe("importThemesJson / export / delete", () => {
  it("导入合法主题并可导出回环（空 name / 非法 base / 内置 id 跳过）", () => {
    const n = importThemesJson(
      JSON.stringify([
        { id: "t1", name: "主题一", base: "light", tokens: { "--accent": "#112233" } },
        { id: "bad", name: "", base: "light" }, // 空 name → 跳过
        { id: "bad2", name: "x", base: "blue" }, // 非法 base → 跳过
        { id: "warm", name: "伪装内置", base: "dark" }, // 内置 id → 拒绝
      ]),
    );
    expect(n).toBe(1);
    const out = JSON.parse(exportThemesJson()) as ThemeDef[];
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("t1");
    expect(out[0].source).toBe("custom");
  });

  it("非数组输入抛错", () => {
    expect(() => importThemesJson('{"a":1}')).toThrow();
  });

  it("upsert 覆盖同 id，delete 移除", () => {
    upsertCustomTheme({ id: "a", name: "A", base: "light", description: "", tokens: {} });
    upsertCustomTheme({ id: "a", name: "A2", base: "dark", description: "", tokens: {} });
    expect(loadThemes().filter((t) => t.id === "a")).toHaveLength(1);
    expect(findTheme("a")?.name).toBe("A2");
    deleteCustomTheme("a");
    expect(findTheme("a")).toBeUndefined();
  });
});

function loadThemes(): ThemeDef[] {
  return JSON.parse(localStorage.getItem("toolbox.custom-themes") ?? "[]") as ThemeDef[];
}

describe("getInitialTheme", () => {
  it("无存储时跟随系统（mock 为 light）", () => {
    expect(getInitialTheme()).toBe("default-light");
  });
  it("旧值 light/dark 迁移到 default-*", () => {
    localStorage.setItem("toolbox.theme", "dark");
    expect(getInitialTheme()).toBe("default-dark");
  });
  it("有效主题 id 原样返回，未知回默认", () => {
    localStorage.setItem("toolbox.theme", "warm");
    expect(getInitialTheme()).toBe("warm");
    localStorage.setItem("toolbox.theme", "no-such");
    expect(getInitialTheme()).toBe("default-light");
  });
});
