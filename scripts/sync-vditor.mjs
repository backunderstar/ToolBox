// 将 Vditor 运行时资源同步到 public/vditor/dist（离线可用）。
// 升级 vditor 后执行: pnpm sync:vditor
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "vditor", "dist");
const dst = join(root, "public", "vditor", "dist");

if (!existsSync(src)) {
  console.error("未找到 vditor 包，请先 pnpm add vditor");
  process.exit(1);
}

// 只拷贝固定目录；lute 是 IR（即时渲染）模式的必需解析引擎，不能排除
mkdirSync(dst, { recursive: true });
cpSync(join(src, "index.css"), join(dst, "index.css"));
cpSync(join(src, "index.js"), join(dst, "index.js"));
for (const rel of ["css", "images"]) {
  cpSync(join(src, rel), join(dst, rel), { recursive: true });
}
mkdirSync(join(dst, "js"), { recursive: true });
for (const dir of ["highlight.js", "i18n", "icons", "katex", "lute", "mermaid"]) {
  cpSync(join(src, "js", dir), join(dst, "js", dir), { recursive: true });
}

console.log("Vditor 离线资源已同步到 public/vditor/dist");
