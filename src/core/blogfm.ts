/**
 * 笔记 frontmatter 读写工具（M7）：`--- key: value ---` 块解析与状态修改。
 */

export interface FmResult {
  fm: Record<string, string>;
  body: string;
  /** 原内容是否带 frontmatter */
  hasFm: boolean;
}

export function parseFrontmatter(content: string): FmResult {
  const body = content.startsWith("\uFEFF") ? content.slice(1) : content;
  if (!body.startsWith("---")) {
    return { fm: {}, body: content, hasFm: false };
  }
  const rest = body.slice(3);
  const end = rest.indexOf("\n---");
  if (end < 0) {
    return { fm: {}, body: content, hasFm: false };
  }
  const fmRaw = rest.slice(0, end);
  const restBody = rest.slice(end + 4);
  const fm: Record<string, string> = {};
  for (const line of fmRaw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf(":");
    if (idx > 0) {
      fm[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
  }
  return { fm, body: restBody.replace(/^\r?\n+/, ""), hasFm: true };
}

/** 设置 status 并返回新内容（无 frontmatter 时在顶部插入） */
export function setStatus(content: string, status: string): string {
  const { fm, body, hasFm } = parseFrontmatter(content);
  fm.status = status;
  const fmText = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const head = `---\n${fmText}\n---`;
  if (hasFm) {
    return `${head}\n\n${body}`;
  }
  return `${head}\n\n${content.trimStart()}`;
}
