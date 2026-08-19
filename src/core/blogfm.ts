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
    // 统一返回去掉 BOM 的 body（原来返回原 content，无 FM 时保留 BOM、有 FM 时去掉，不一致）
    return { fm: {}, body, hasFm: false };
  }
  const rest = body.slice(3);
  const end = rest.indexOf("\n---");
  if (end < 0) {
    return { fm: {}, body, hasFm: false };
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

/**
 * 设置 status 并返回新内容。
 * 行级替换 `status:` 行（保留注释、键序、格式），而不是重建整个 frontmatter——
 * 原实现会丢注释并重排键序，对"只改状态"的操作改动面过大。
 * 无 frontmatter 时在顶部插入完整块。
 */
export function setStatus(content: string, status: string): string {
  const { hasFm } = parseFrontmatter(content);
  if (!hasFm) {
    return `---\nstatus: ${status}\n---\n\n${content.trimStart()}`;
  }
  const body = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const rest = body.slice(3);
  const end = rest.indexOf("\n---");
  const fmRaw = rest.slice(0, end).trim();
  const restBody = rest.slice(end + 4);
  const statusRe = /^status\s*:.*$/m;
  const newFm = statusRe.test(fmRaw)
    ? fmRaw.replace(statusRe, `status: ${status}`)
    : `${fmRaw}${fmRaw ? "\n" : ""}status: ${status}`;
  return `---\n${newFm}\n---${restBody}`;
}
