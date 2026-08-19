import { describe, expect, it } from "vitest";
import { parseFrontmatter, setStatus } from "./blogfm";

describe("parseFrontmatter", () => {
  it("无 frontmatter 时返回原 body（hasFm=false）", () => {
    const r = parseFrontmatter("# 标题\n内容");
    expect(r.hasFm).toBe(false);
    expect(r.body).toBe("# 标题\n内容");
    expect(r.fm).toEqual({});
  });

  it("带 BOM 的无 FM 内容统一去 BOM", () => {
    const r = parseFrontmatter("\uFEFF# 标题");
    expect(r.hasFm).toBe(false);
    expect(r.body).toBe("# 标题");
  });

  it("解析 frontmatter 键值并去首空行", () => {
    const r = parseFrontmatter("---\ntitle: 你好\ndate: 2024-01-01\n---\n\n正文");
    expect(r.hasFm).toBe(true);
    expect(r.fm).toEqual({ title: "你好", date: "2024-01-01" });
    expect(r.body).toBe("正文");
  });

  it("跳过注释与空行", () => {
    const r = parseFrontmatter("---\n# 注释\n\ntitle: x\n---\nbody");
    expect(r.fm).toEqual({ title: "x" });
    expect(r.body).toBe("body");
  });

  it("`---` 开头但无闭合时视为无 FM", () => {
    const r = parseFrontmatter("---\ntitle: x\n正文");
    expect(r.hasFm).toBe(false);
  });

  it("值含冒号只切第一个分隔符", () => {
    const r = parseFrontmatter("---\ntitle: a:b\n---\nbody");
    expect(r.fm).toEqual({ title: "a:b" });
  });
});

describe("setStatus", () => {
  it("无 FM 时插入完整块", () => {
    const out = setStatus("正文", "published");
    expect(out).toBe("---\nstatus: published\n---\n\n正文");
  });

  it("替换已有 status 行并保留其他键", () => {
    const out = setStatus("---\ntitle: a\nstatus: draft\n---\n正文", "published");
    expect(out).toContain("status: published");
    expect(out).not.toContain("status: draft");
    expect(out).toContain("title: a");
  });

  it("无 status 键时追加", () => {
    const out = setStatus("---\ntitle: a\n---\n正文", "published");
    expect(out).toContain("title: a");
    expect(out).toContain("status: published");
  });
});
