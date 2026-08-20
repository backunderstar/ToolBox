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

// 只拷贝固定目录；lute 是 IR（即时渲染）模式的必需解析引擎，不能排除
mkdirSync(dst, { recursive: true });
cpSync(join(src, "index.css"), join(dst, "index.css"));
cpSync(join(src, "index.js"), join(dst, "index.js"));
for (const rel of ["css", "images"]) {
  cpSync(join(src, rel), join(dst, rel), { recursive: true });
}
mkdirSync(join(dst, "js"), { recursive: true });
for (const dir of ["highlight.js", "icons", "katex", "lute", "mermaid"]) {
  cpSync(join(src, "js", dir), join(dst, "js", dir), { recursive: true });
}
// i18n 裁剪：应用固定 lang:"zh_CN"（core-notes ui），只保留中文与英文兜底
// （Vditor 按需动态 import 语言文件，其余 10 种语言从不加载，不必随包分发）。
// 先清空目标再拷：cpSync 不会删除目标里多余文件，重复运行会累积旧语言包
rmSync(join(dst, "js", "i18n"), { recursive: true, force: true });
mkdirSync(join(dst, "js", "i18n"), { recursive: true });
for (const lang of ["zh_CN.js", "en_US.js"]) {
  cpSync(join(src, "js", "i18n", lang), join(dst, "js", "i18n", lang));
}

console.log("Vditor 离线资源已同步到 public/vditor/dist");
