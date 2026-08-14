// 将 Vditor 运行时资源同步到 public/vditor/dist（离线可用）。
// 升级 vditor 后执行: pnpm sync:vditor
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "vditor", "dist");
const dst = join(root, "public", "vditor", "dist");

if (!existsSync(src)) {
  console.error("未找到 vditor 包，请先 pnpm add vditor");
  process.exit(1);
}

// 按需加载、当前用不到的重型引擎不拷贝（mathjax/lute/echarts 等）
const SKIP_JS_DIRS = new Set([
  "abcjs",
  "echarts",
  "flowchart.js",
  "graphviz",
  "markmap",
  "mathjax",
  "lute",
  "plantuml",
  "smiles-drawer",
  "wavedrom",
]);

mkdirSync(dst, { recursive: true });
cpSync(join(src, "index.css"), join(dst, "index.css"));
for (const rel of ["css", "images"]) {
  cpSync(join(src, rel), join(dst, rel), { recursive: true });
}
mkdirSync(join(dst, "js"), { recursive: true });
for (const dir of ["highlight.js", "i18n", "icons", "katex", "mermaid"]) {
  cpSync(join(src, "js", dir), join(dst, "js", dir), { recursive: true });
}

console.log("Vditor 离线资源已同步到 public/vditor/dist");
