// 作者侧插件打包 CLI：把插件目录打成可分发 .zip（与应用内「导出」互补——
// 应用内导出是"打包已安装插件的全部内容"，本脚本是"作者开发目录 → 分发包"，
// 自动排除依赖/缓存目录，产物更小）。
//
// 用法：node scripts/package-plugin.mjs <插件目录> [-o 输出路径.zip]
//   示例：pnpm package-plugin plugins/py-tools
//         pnpm package-plugin D:/dev/my-plugin -o dist/my-plugin.zip
//
// 排除（目标机用「安装依赖」按钮重建，或自带 env/ 方案自行处理）：
//   vendor/ env/ .venv/ node_modules/ __pycache__/ *.pyc .git/ .DS_Store Thumbs.db
// 包含 ui/index.js + ui/style.css（运行必需；构建前先跑模板的 npm run build
// 或仓库的 pnpm build-external-ui <插件目录>）。
//
// 产物顶层目录 = <插件id>/（与 Rust 侧 export_zip 一致），对方可在插件页
// 「安装 .zip」直接导入，或解压到全局插件目录后点刷新。

import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// archiver 8（ESM 重构）：ZipArchive 独立类（见 platform.mjs zipDirectory 同款用法）
const { ZipArchive } = await import("archiver");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dirArg = args.find((a) => !a.startsWith("-"));
const outArgIdx = args.indexOf("-o");
const outArg = outArgIdx >= 0 ? args[outArgIdx + 1] : undefined;

if (!dirArg) {
  console.error("用法: node scripts/package-plugin.mjs <插件目录> [-o 输出路径.zip]");
  process.exit(1);
}

const pluginDir = path.resolve(root, dirArg);
const manifestPath = path.join(pluginDir, "plugin.json");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(`不是有效的插件目录（缺 plugin.json 或 JSON 非法）: ${pluginDir}\n${e}`);
  process.exit(1);
}
const id = manifest.id;
if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
  console.error(`plugin.json 缺合法 id（小写字母/数字/连字符）: ${JSON.stringify(id)}`);
  process.exit(1);
}

const outPath = path.resolve(outArg ?? path.join(path.dirname(pluginDir), `${id}.zip`));
mkdirSync(path.dirname(outPath), { recursive: true });

/** 排除规则：目录名黑名单 + 文件名后缀黑名单（含任意层级） */
const EXCLUDE_DIRS = new Set(["vendor", "env", ".venv", "node_modules", "__pycache__", ".git"]);
const EXCLUDE_FILES = /\.(pyc|pyo)$|^\.DS_Store$|^Thumbs\.db$/i;

const output = createWriteStream(outPath);
const zip = new ZipArchive({ zlib: { level: 9 } });
let fileCount = 0;
let dirCount = 0;

zip.on("warning", (err) => {
  if (err.code === "ENOENT") console.warn(`[warn] ${err.message}`);
  else throw err;
});
output.on("close", () => {
  const sizeMB = (statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log(`✔ 已打包 ${id} → ${outPath}`);
  console.log(`  ${dirCount} 个目录 / ${fileCount} 个文件 / ${sizeMB} MB`);
  console.log("分发：对方在插件页「安装 .zip」导入，或解压到全局插件目录后点刷新。");
});
zip.pipe(output);

/** 手动递归（与 Rust 侧 write_dir_to_zip 同构）：跳过黑名单目录，逐文件 append。 */
function walk(dir, rel) {
  const entries = readdirSync(dir).sort();
  for (const name of entries) {
    const abs = path.join(dir, name);
    const next = rel ? `${rel}/${name}` : name;
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue; // 依赖/缓存目录：目标机重建
      zip.append(null, { name: `${next}/` });
      dirCount += 1;
      walk(abs, next);
    } else if (!EXCLUDE_FILES.test(name)) {
      zip.append(createReadStream(abs), { name: next });
      fileCount += 1;
    }
  }
}

walk(pluginDir, id);
await zip.finalize();
