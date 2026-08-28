// fetch-python.mjs — 下载 python-build-standalone 捆绑运行时到 src-tauri/resources/python/。
//
// 背景：process 插件（Python）需要解释器，但目标机可能没装 Python。应用随包分发一份
// 可重定位的 CPython（python-build-standalone，astral-sh 维护，uv 内置的同一套发行版：
// 不写注册表、路径无关、离线可用），运行时由宿主部署到 %APPDATA%/com.toolbox.desktop/python/
// 并优先使用（见 src-tauri/src/plugins/pyruntime.rs）。
//
// 用法：
//   pnpm fetch:python                 # 下载最新 release 的 3.14 full 变体（Windows x86_64）
//   pnpm fetch:python --version 3.13  # 指定大版本
//   pnpm fetch:python --force         # 已存在也重新下载（换版本/强制刷新时用）
//   pnpm fetch:python --mirror https://ghfast.top/
//                                     # GitHub 直连慢时走镜像前缀（实测 ghfast.top 可用，
//                                     # ~1.4MB/s；SHA256SUMS 仍校验，镜像只加速传输不改内容）
//
// 变体说明（命名随 python-build-standalone 演进，2026-08 起 full 变体为 pgo+full 且用 zstd 压缩）：
//   - full（含 pip）：默认。插件页后续"安装依赖"、插件目录 pip install --target 需要 pip。
//     资产形如 cpython-3.14.x+<tag>-x86_64-pc-windows-msvc-pgo-full.tar.zst（zstd 压缩，
//     需 bsdtar 带 libzstd——解压只发生在构建期，目标机拿到的是解压后的目录）
//   - install_only（无 pip）：体积更小；仅当确认永远不需要在目标机装依赖时用
//     （改脚本里的 VARIANT 常量，资产为 .tar.gz）
//
// 产物：src-tauri/resources/python/（tauri.conf.json bundle.resources 已声明，随 NSIS 分发）
// 校验：从该 release 的 SHA256SUMS 资产核对 tarball 哈希，不信任下载源。
// 非 Windows：跳过（打包仅面向 Windows NSIS；dev 回落系统 python）。
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { isWindows } from "./platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destDir = path.join(root, "src-tauri", "resources", "python");
const workDir = path.join(root, "target", "python-fetch"); // gitignored（target/）
const RELEASE_REPO = "astral-sh/python-build-standalone";
const VARIANT = "full"; // full（含 pip）| install_only

const args = process.argv.slice(2);
const versionIdx = args.indexOf("--version");
const wantMajor = versionIdx >= 0 ? args[versionIdx + 1] : "3.14";
const force = args.includes("--force");
const mirrorIdx = args.indexOf("--mirror");
const mirror = mirrorIdx >= 0 ? args[mirrorIdx + 1] : null; // 如 https://ghfast.top/
if (mirror && !/^https?:\/\/.+/.test(mirror)) {
  throw new Error(`--mirror 需要完整 URL 前缀（如 https://ghfast.top/）: ${mirror}`);
}

function log(...m) {
  console.log("[fetch:python]", ...m);
}

if (!isWindows) {
  log("非 Windows 平台：跳过（打包仅面向 Windows NSIS；dev 回落系统 python）");
  process.exit(0);
}
if (existsSync(path.join(destDir, "python.exe")) && !force) {
  log(`已存在 ${destDir}（--force 重新下载/换版本）`);
  process.exit(0);
}

/** 下载文件到本地路径（流式，不整包进内存）。 */
async function download(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": "toolbox-fetch-python" } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function sha256File(p) {
  const h = createHash("sha256");
  await pipeline(createReadStream(p), h);
  return h.digest("hex");
}

// 1. 解析最新 release（GitHub API 未鉴权 60 次/小时，按需调用即可）
log("查询最新 release ...");
const release = await (async () => {
  const url = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
  const res = await fetch(url, { headers: { "User-Agent": "toolbox-fetch-python" } });
  if (!res.ok) throw new Error(`查询 GitHub API 失败 HTTP ${res.status}（需联网；可手动下载后解压到 ${destDir}）`);
  return res.json();
})();
const tag = release.tag_name;
log(`release: ${tag}`);

const wantPrefix = `cpython-${wantMajor}.`;
// full → -pgo-full.tar.zst（2026-08 起的标准 full 变体）；install_only → -install_only.tar.gz
// 显式尾缀匹配，避开 freethreaded / i686 / aarch64 / stripped 等变体
const assetSuffix =
  VARIANT === "full"
    ? "-x86_64-pc-windows-msvc-pgo-full.tar.zst"
    : "-x86_64-pc-windows-msvc-install_only.tar.gz";
const asset = release.assets.find(
  (a) => a.name.startsWith(wantPrefix) && a.name.endsWith(assetSuffix),
);
if (!asset) {
  throw new Error(`release ${tag} 中未找到 ${wantPrefix}* 的 ${VARIANT} 变体 Windows x86_64 资产`);
}
const sums = release.assets.find((a) => a.name === "SHA256SUMS");
if (!sums) throw new Error(`release ${tag} 缺少 SHA256SUMS 资产`);

mkdirSync(workDir, { recursive: true });
const tarPath = path.join(workDir, asset.name);
const sumsPath = path.join(workDir, "SHA256SUMS");

// 2. 下载 + SHA256 校验（--mirror 时资产与校验和都走镜像前缀；内容仍由 SHA256 保证）
// 已下载过（上次解压失败重跑等）则跳过下载直接校验
const assetUrl = mirror ? mirror + asset.browser_download_url : asset.browser_download_url;
const sumsUrl = mirror ? mirror + sums.browser_download_url : sums.browser_download_url;
if (!existsSync(tarPath) || !existsSync(sumsPath)) {
  log(`下载 ${asset.name}（${(asset.size / 1048576).toFixed(1)} MB）${mirror ? `via ${mirror}` : ""}...`);
  if (!existsSync(tarPath)) await download(assetUrl, tarPath);
  if (!existsSync(sumsPath)) {
    log("下载 SHA256SUMS 并校验 ...");
    await download(sumsUrl, sumsPath);
  }
} else {
  log(`使用已下载的 ${asset.name}（跳过下载，仍校验）`);
}
const expectedLine = readFileSync(sumsPath, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .find((l) => l.endsWith(asset.name));
if (!expectedLine) throw new Error(`SHA256SUMS 中没有 ${asset.name}`);
const wantHash = expectedLine.split(/\s+/)[0];
const gotHash = await sha256File(tarPath);
if (gotHash !== wantHash) {
  throw new Error(`SHA256 校验失败：期望 ${wantHash}，实际 ${gotHash}（请勿使用）`);
}
log(`SHA256 校验通过（${wantHash.slice(0, 16)}…）`);

// 归档结构（2026-08 起）：顶层 python/ 含 install/（真正运行时）+ PYTHON.json 元数据；
// 早期版本顶层 python/ 即运行时。动态定位含 python.exe 的目录作为运行时根。
log("解压到 src-tauri/resources/python/ ...");
const extractTmp = path.join(workDir, "extract");
rmSync(extractTmp, { recursive: true, force: true });
mkdirSync(extractTmp, { recursive: true });
try {
  execFileSync("tar", ["-xzf", tarPath, "-C", extractTmp], { stdio: "inherit" });
} catch (e) {
  throw new Error(`解压失败（需要 bsdtar/tar）：${e.message}`);
}
const candidates = [
  extractTmp,
  path.join(extractTmp, "python"),
  path.join(extractTmp, "python", "install"),
];
const extracted = candidates.find((p) => existsSync(path.join(p, "python.exe")));
if (!extracted) {
  throw new Error("解压产物缺少 python.exe（归档结构异常）");
}
rmSync(destDir, { recursive: true, force: true });
mkdirSync(path.dirname(destDir), { recursive: true });
renameSync(extracted, destDir);
rmSync(extractTmp, { recursive: true, force: true });
rmSync(tarPath, { force: true });

// 4. 瘦身：目标机只运行不编译/不调试，移除运行时不需要的部分
//    （full 变体带 ~90MB pdb 调试符号 + 32MB 测试套件；删掉后体积腰斩）
slimPython(destDir);

function dirSize(dir) {
  let total = 0;
  for (const rel of readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, rel);
    try {
      if (statSync(p).isFile()) total += statSync(p).size;
    } catch {
      /* 竞态/已删，忽略 */
    }
  }
  return total;
}

/** 递归移除 *.pdb（调试符号）、Lib/test（测试套件）、__pycache__ 与 *.pyc（运行时自动重建）。 */
function slimPython(dir) {
  const before = dirSize(dir);
  const all = readdirSync(dir, { recursive: true });
  // 先删目录（__pycache__），再删文件（避免顺序问题）
  for (const rel of all) {
    const p = path.join(dir, rel);
    if (path.basename(rel) === "__pycache__") rmSync(p, { recursive: true, force: true });
  }
  for (const rel of readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, rel);
    const base = path.basename(rel);
    if (base.endsWith(".pdb") || base.endsWith(".pyc")) rmSync(p, { force: true });
  }
  rmSync(path.join(dir, "Lib", "test"), { recursive: true, force: true });
  const after = dirSize(dir);
  log(`瘦身：${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB（移除 pdb/测试套件/字节码缓存）`);
}

log(`完成：${destDir}`);
log(`  版本 ${asset.name}（${tag}），SHA256 ${wantHash}`);
log(`  打包：tauri.conf.json bundle.resources 已含 resources/python，随安装包分发`);
log(`  验证：pnpm doctor 应显示"捆绑 Python 运行时"就绪`);
