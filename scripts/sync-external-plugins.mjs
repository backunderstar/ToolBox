// 同步外部插件到应用插件目录（Windows %APPDATA% / macOS Application Support / Linux ~/.config）。
//
// 为什么需要：应用只从全局插件目录加载外部插件（src-tauri/src/plugins/mod.rs
// 的 global_plugins_dir），仓库 plugins/ 下的改动不会自动生效。开发时改了
// 外部插件源码（main.js/main.py/vendor 等）后跑本脚本同步过去。
//
// 用法：pnpm sync:plugins
// 注意：
// - process 插件（py-tools / csv-tool）的 Python/JS 进程常驻：同步后需在
//   插件页点「重新加载」或重启应用才生效。
// - webview 插件的 ui 产物由 scripts/build-external-ui.mjs 生成
//   （ui/index.js），本脚本会一并同步；改了 ui/index.ts 需先跑
//   pnpm build-external-ui plugins/<插件>。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginsDir } from "./platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(root, "plugins");
const dstRoot = pluginsDir();

/** 同步时跳过的内容（node_modules 大、__pycache__ 是运行时产物） */
const SKIP = new Set(["node_modules", "__pycache__", ".git"]);

/** 递归统计文件数与字节数（用于输出） */
function measure(dir, acc = { files: 0, bytes: 0 }) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) measure(p, acc);
    else {
      acc.files += 1;
      acc.bytes += st.size;
    }
  }
  return acc;
}

if (!existsSync(srcRoot)) {
  console.error(`未找到外部插件目录: ${srcRoot}`);
  process.exit(1);
}

const plugins = readdirSync(srcRoot).filter((n) => {
  if (n.startsWith(".")) return false;
  const p = path.join(srcRoot, n);
  return statSync(p).isDirectory() && existsSync(path.join(p, "plugin.json"));
});

if (plugins.length === 0) {
  console.log("[sync-plugins] plugins/ 下没有外部插件（需含 plugin.json）");
  process.exit(0);
}

mkdirSync(dstRoot, { recursive: true });
let totalFiles = 0;
let totalBytes = 0;

for (const name of plugins) {
  const src = path.join(srcRoot, name);
  const dst = path.join(dstRoot, name);
  // 全量重建：删除旧目录再复制，避免残留已删除的文件（如改名后的 ui 产物）
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      const first = rel.split(/[\\/]/)[0];
      return !SKIP.has(first) && !first.startsWith(".");
    },
  });
  const m = measure(dst);
  totalFiles += m.files;
  totalBytes += m.bytes;
  console.log(
    `[sync-plugins] ${name} → ${dst}（${m.files} 文件，${(m.bytes / 1024).toFixed(1)} KB）`,
  );
}

console.log(
  `[sync-plugins] 完成：${plugins.length} 个插件，共 ${totalFiles} 文件 / ${(totalBytes / 1024).toFixed(1)} KB`,
);
console.log(
  "[sync-plugins] 提示：process 插件（Python/JS）进程常驻，需在插件页「重新加载」或重启应用后生效。",
);
