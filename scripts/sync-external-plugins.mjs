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
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginsDir } from "./platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(root, "plugins");
const dstRoot = pluginsDir();

/** 同步时跳过的内容（node_modules 大、__pycache__ 是运行时产物） */
const SKIP = new Set(["node_modules", "__pycache__", ".git"]);

/** 本地生成目录（不入库）：vendored 依赖 / 方案 B env / 方案 C .venv / node_modules。
    全量重建会删掉它们——同步前移到同卷临时区，重建完成后移回（依赖保留、源码更新；
    否则每次 sync 都会清掉「安装依赖」/pip 装的依赖，目标机还得重装）。 */
const LOCAL_DIRS = ["vendor", "env", ".venv", "node_modules"];

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
let failures = 0;

for (const name of plugins) {
  const src = path.join(srcRoot, name);
  const dst = path.join(dstRoot, name);

  // 1. 保留本地生成目录（依赖，不入库）：先移到同卷临时区，重建后移回
  const stash = [];
  for (const d of LOCAL_DIRS) {
    const p = path.join(dst, d);
    if (existsSync(p)) {
      const tmp = path.join(os.tmpdir(), `tb-sync-${name}-${d}-${process.pid}`);
      rmSync(tmp, { recursive: true, force: true });
      try {
        renameSync(p, tmp);
        stash.push({ tmp, d });
        console.log(`[sync-plugins] 保留本地依赖目录: ${name}/${d}`);
      } catch (e) {
        console.warn(
          `[sync-plugins] 保留 ${name}/${d} 失败（将随重建删除，可重新「安装依赖」）: ${e.message}`,
        );
      }
    }
  }

  // 2. 重建其余内容（源码 + ui 产物）；单插件失败仅告警，不阻断其他插件
  let ok = false;
  try {
    // 全量重建：删除旧目录再复制，避免残留已删除的文件（如改名后的 ui 产物）
    rmSync(dst, { recursive: true, force: true });
    cpSync(src, dst, {
      recursive: true,
      filter: (p) => {
        const rel = path.relative(src, p);
        const parts = rel.split(/[\\/]/);
        const first = parts[0];
        if (SKIP.has(first) || first.startsWith(".")) return false;
        // ui 目录只同步构建产物（index.js / style.css）：源码（index.ts / App.vue 等）
        // 留在仓库，由 pnpm build-external-ui 构建；与应用目录部署模式一致（产物不入库）
        if (first === "ui") {
          if (parts.length === 1) return true; // ui 目录本身（保留结构）
          return parts[parts.length - 1] === "index.js" || parts[parts.length - 1] === "style.css";
        }
        return true;
      },
    });
    ok = true;
  } catch (e) {
    failures += 1;
    console.error(`[sync-plugins] 同步 ${name} 失败（已跳过，其他插件不受影响）: ${e.message}`);
  }

  // 3. 移回保留的依赖目录；目标已存在（仓库也入库了同名目录，如 py-tools/vendor
  //    的历史 vendor）→ 仓库版本优先，丢弃本地保留副本
  for (const { tmp, d } of stash) {
    const back = path.join(dst, d);
    if (existsSync(back)) {
      console.warn(
        `[sync-plugins] ${name}/${d} 仓库已有同目录（入库依赖），以仓库版本为准，丢弃本地保留副本`,
      );
      rmSync(tmp, { recursive: true, force: true });
      continue;
    }
    try {
      renameSync(tmp, back);
    } catch (e) {
      failures += 1;
      console.error(`[sync-plugins] 移回 ${name}/${d} 失败（可重新「安装依赖」）: ${e.message}`);
    }
  }

  if (ok) {
    const m = measure(dst);
    totalFiles += m.files;
    totalBytes += m.bytes;
    console.log(
      `[sync-plugins] ${name} → ${dst}（${m.files} 文件，${(m.bytes / 1024).toFixed(1)} KB）`,
    );
  }
}

if (failures > 0) {
  console.error(`[sync-plugins] 完成：${plugins.length} 个插件，其中 ${failures} 个失败`);
  process.exitCode = 1;
} else {
  console.log(
    `[sync-plugins] 完成：${plugins.length} 个插件，共 ${totalFiles} 文件 / ${(totalBytes / 1024).toFixed(1)} KB`,
  );
}
console.log(
  "[sync-plugins] 提示：process 插件（Python/JS）进程常驻，需在插件页「重新加载」或重启应用后生效。",
);
