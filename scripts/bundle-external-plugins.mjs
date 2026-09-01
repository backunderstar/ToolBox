// 随包外部插件：把 `plugins/<id>` 复制进 `src-tauri/resources/bundled-plugins/<id>/`，
// 随安装包分发（bundle.resources），首启由宿主 `ensure_bundled_plugins` 部署到全局
// 插件目录（与核心插件 `_core` 同构；但目标是顶层目录，走普通外部插件发现流程）。
//
// 用法：pnpm bundle:plugins（release 打包前由 tauri beforeBuildCommand 自动执行；
// CI 的 cargo test 只需占位目录，见 ci.yml "Create bundled python resource placeholder"）
//
// 复制策略：
// - **保留 vendor/**（用户决策：离线依赖随包，目标机零配置可用）
// - ui/ 用 production 构建产物（经 plugin-ui-build.mjs，直接进 bundled 资源，
//   不污染源码目录的 dev 产物）
// - 排除运行期/缓存/测试产物：cache/ jobs/ test/ __pycache__/ *.pyc *.pyo *.log
//
// 新增随包插件：往 BUNDLED 数组加一项（目录须在 plugins/<id>，有合法 plugin.json）。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginUi } from "./plugin-ui-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 随包插件清单（2026-09：探针卡分层已 Rust 化为核心插件 core-plugins/probe-rat-layer，
// 不再作为外部插件随包；此列表为空，后续新增外部随包插件再加回去）
const BUNDLED = [];

/** 排除目录（任意层级）：运行期产物/缓存/测试/版本控制 */
const EXCLUDE_DIRS = new Set(["cache", "jobs", "test", "__pycache__", ".git", "node_modules"]);
/** 排除文件（任意层级） */
const EXCLUDE_FILES = /\.(pyc|pyo)$|\.log$|^pytest\.ini$|^\.DS_Store$|^Thumbs\.db$/i;

/** 递归复制，跳过黑名单（目录/文件） */
function copyTree(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  let n = 0;
  for (const name of readdirSync(srcDir)) {
    const abs = path.join(srcDir, name);
    const out = path.join(dstDir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      n += copyTree(abs, out);
    } else if (!EXCLUDE_FILES.test(name)) {
      cpSync(abs, out);
      n += 1;
    }
  }
  return n;
}

const outRoot = path.join(root, "src-tauri", "resources", "bundled-plugins");
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

for (const id of BUNDLED) {
  const src = path.join(root, "plugins", id);
  const target = path.join(outRoot, id);
  if (!existsSync(path.join(src, "plugin.json"))) {
    throw new Error(`[bundle-plugins] ${id} 不是有效插件目录（缺 plugin.json）: ${src}`);
  }
  const manifest = JSON.parse(readFileSync(path.join(src, "plugin.json"), "utf8"));
  if (manifest.id !== id) {
    throw new Error(`[bundle-plugins] ${id}/plugin.json 的 id 与目录名不一致: ${manifest.id}`);
  }

  // UI：manifest 声明了 ui 且源码存在 → production 构建（产物直接进 bundled 资源）
  const entryTs = path.join(src, "ui", "index.ts");
  const entryTsx = path.join(src, "ui", "index.tsx");
  if (manifest.ui && (existsSync(entryTs) || existsSync(entryTsx))) {
    const entry = existsSync(entryTs) ? entryTs : entryTsx;
    const uiOut = path.join(root, "target", "external-ui", id);
    await buildPluginUi({ root, entry, outDir: uiOut, env: "production" });
    const uiTarget = path.join(target, "ui");
    mkdirSync(uiTarget, { recursive: true });
    for (const f of ["index.js", "style.css"]) {
      if (existsSync(path.join(uiOut, f))) cpSync(path.join(uiOut, f), path.join(uiTarget, f));
    }
    console.log(`[bundle-plugins] ${id}: production ui 已构建 → bundled 资源`);
  }

  const count = copyTree(src, target);
  // 自检：plugin.json 与运行必需文件齐全（process 插件缺 main.py = 部署了坏插件）
  for (const required of ["plugin.json", "main.py"]) {
    if (!existsSync(path.join(target, required))) {
      throw new Error(`[bundle-plugins] 自检失败: ${id}/${required} 缺失`);
    }
  }
  if (manifest.ui && !existsSync(path.join(target, "ui", "index.js"))) {
    throw new Error(`[bundle-plugins] 自检失败: ${id} 声明了 ui 但缺 ui/index.js（构建异常）`);
  }
  const sizeMB = (() => {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).reduce((s, e) => {
      const p = path.join(d, e.name);
      return s + (e.isDirectory() ? walk(p) : statSync(p).size);
    }, 0);
    return walk(target) / 1024 / 1024;
  })();
  console.log(`[bundle-plugins] 已随包: ${id} → ${target}（${count} 个文件，${sizeMB.toFixed(1)} MB，含 vendor）`);
}

console.log(`[bundle-plugins] 完成: ${BUNDLED.length} 个插件进入安装包资源`);
