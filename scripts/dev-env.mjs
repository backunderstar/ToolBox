// dev-env.mjs — 开发环境检测与一键初始化（跨平台：Windows / macOS / Linux）。
//
// 用法：
//   pnpm doctor       环境检测报告（node/pnpm/rust/平台系统依赖/依赖安装状态）
//   pnpm env:setup    检测 + 一键初始化（缺什么装什么：pnpm install → cargo fetch
//                     → build:core 部署核心插件）
//
// 为什么需要：ToolBox 依赖 Node + pnpm + Rust 工具链 + 平台系统依赖（Tauri 2）。
// 新机器/新成员常因缺依赖而反复踩坑（尤其 Linux 的 webkit2gtk）。本脚本一次性
// 给出完整报告与一键修复，跨平台行为一致。
// 注意：脚本名用 env:setup 而非 setup——`pnpm setup` 是 pnpm 内置命令，会遮蔽同名 script。
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLinux, isMac, isWindows, platformName } from "./platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const wantInstall = args.has("--install") || args.has("--setup");

/** 运行命令并返回 stdout（失败返回 null），用于"存在性/版本"探测。
 *  用 execSync（走系统 shell）：Windows 上 pnpm/rustc 等是 .cmd 包装，
 *  execFileSync 无法直接解析，shell 方式三平台行为一致。 */
function tryCmd(cmdline) {
  try {
    return execSync(cmdline, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

let failed = 0;
const report = [];
const fixes = [];

function check(name, ok, detail, fix) {
  report.push({ name, ok, detail, fix });
  if (!ok) {
    failed += 1;
    if (fix) fixes.push(`${name}: ${fix}`);
  }
}

console.log(`\n== ToolBox 开发环境检测（${platformName}）==\n`);

/* ---- 1. Node 工具链 ---- */
const nodeV = process.version.slice(1);
const nodeOk = Number(nodeV.split(".")[0]) >= 20;
check("Node.js", nodeOk, nodeV, "需要 Node ≥ 20（https://nodejs.org）");

const pnpmV = tryCmd("pnpm --version");
check("pnpm", !!pnpmV, pnpmV ?? "未安装", "安装 pnpm：npm i -g pnpm 或 corepack enable");

/* ---- 2. Rust 工具链 ---- */
const rustcV = tryCmd("rustc --version");
const cargoV = tryCmd("cargo --version");
check("rustc", !!rustcV, rustcV ?? "未安装", "安装 Rust：https://rustup.rs（rustup-init）");
check("cargo", !!cargoV, cargoV ?? "未安装", "安装 Rust：https://rustup.rs（rustup-init）");

/* ---- 3. 平台系统依赖（Tauri 2 运行时要求） ---- */
if (isLinux) {
  // Tauri v2 Linux 系统依赖（Debian/Ubuntu 系，pkg-config 探测）
  const need = [
    ["webkit2gtk-4.1", "libwebkit2gtk-4.1-dev"],
    ["javascriptcoregtk-4.1", "libwebkit2gtk-4.1-dev"],
    ["soup-3.0", "libsoup-3.0-dev"],
    ["librsvg-2.0", "librsvg2-dev"],
    ["ayatana-appindicator3-0.1", "libayatana-appindicator3-dev"],
  ];
  const missingPkgs = [];
  for (const [pc, apt] of need) {
    const ok = tryCmd(`pkg-config --exists ${pc}`) !== null;
    if (!ok) missingPkgs.push(apt);
  }
  check(
    "Tauri 系统依赖（webkit2gtk 等）",
    missingPkgs.length === 0,
    missingPkgs.length === 0 ? "全部就绪" : `缺少: ${missingPkgs.join(", ")}`,
    missingPkgs.length === 0
      ? null
      : `sudo apt install build-essential curl wget file libssl-dev libxdo-dev ${missingPkgs.join(" ")}`,
  );
  const linker = tryCmd("cc --version");
  check("C 编译器（cc）", !!linker, linker?.split("\n")[0] ?? "未安装", "sudo apt install build-essential");
} else if (isMac) {
  const clt = tryCmd("xcode-select -p");
  check(
    "Xcode Command Line Tools",
    !!clt,
    clt ?? "未安装",
    "xcode-select --install（Tauri 需要编译工具链）",
  );
} else if (isWindows) {
  // MSVC 工具链：cl.exe 只在 VS 开发者环境中可见，vswhere 也不在 PATH。
  // 方案：vswhere 固定路径优先（能发现任意盘符的安装），回退标准安装目录探测。
  let msvcOk = false;
  let msvcDetail = "未检测到";
  const vswhere =
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  try {
    if (existsSync(vswhere)) {
      const p = execSync(
        `"${vswhere}" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`,
        { stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .trim();
      if (p) {
        const tools = path.join(p, "VC", "Tools", "MSVC");
        msvcOk = existsSync(tools) && readdirSync(tools).length > 0;
        msvcDetail = msvcOk ? p : "未检测到";
      }
    }
  } catch {
    /* vswhere 异常 → 走目录探测 */
  }
  if (!msvcOk) {
    const vsRoots = [
      "C:\\Program Files\\Microsoft Visual Studio\\2022",
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022",
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\2019",
      "C:\\Program Files\\Microsoft Visual Studio\\2019",
    ];
    for (const vsRoot of vsRoots) {
      if (!existsSync(vsRoot)) continue;
      try {
        for (const ed of readdirSync(vsRoot)) {
          const tools = path.join(vsRoot, ed, "VC", "Tools", "MSVC");
          if (existsSync(tools) && readdirSync(tools).length > 0) {
            msvcOk = true;
            msvcDetail = path.join(vsRoot, ed);
          }
        }
      } catch {
        /* 无权限/异常则跳过 */
      }
    }
  }
  check(
    "Visual Studio Build Tools（MSVC）",
    msvcOk,
    msvcDetail,
    "安装 VS Build Tools（含「使用 C++ 的桌面开发」工作负载）：https://visualstudio.microsoft.com/zh-hans/downloads/",
  );
  const webview = existsSync("C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application") ||
    existsSync("C:\\Program Files\\Microsoft\\EdgeWebView\\Application");
  check("WebView2 运行时", webview, webview ? "已安装" : "未检测到", "通常随 Windows/Edge 自带；缺失时从微软官网安装 WebView2 Runtime");
}

/* ---- 4. 前端依赖与构建缓存 ---- */
const hasModules = existsSync(path.join(root, "node_modules"));
check(
  "前端依赖（node_modules）",
  hasModules,
  hasModules ? "已安装" : "未安装",
  wantInstall ? null : "运行 pnpm install（或 pnpm setup）",
);

const hasTarget = existsSync(path.join(root, "target"));
check(
  "Rust 构建缓存（target/）",
  hasTarget,
  hasTarget ? "存在" : "尚无（首次构建会较慢）",
  null,
);

/* ---- 5. 捆绑 Python 运行时（process 插件在目标机无 Python 时靠它） ---- */
const hasBundledPython = existsSync(
  path.join(root, "src-tauri", "resources", "python", "python.exe"),
);
check(
  "捆绑 Python 运行时（resources/python）",
  hasBundledPython,
  hasBundledPython ? "已就绪（随安装包分发，目标机无需 Python）" : "未下载",
  wantInstall ? null : "运行 pnpm fetch:python（下载 python-build-standalone full 变体）",
);

/* ---- 汇总 ---- */
console.log("----------------------------------------");
for (const r of report) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(24)} ${r.detail}`);
}
console.log("----------------------------------------");
if (failed === 0) {
  console.log("全部就绪 ✓  接下来：pnpm build:core && pnpm tauri dev\n");
} else {
  console.log(`发现 ${failed} 项缺失：\n`);
  for (const f of fixes) console.log(`  · ${f}`);
  console.log("\n修复后重跑 pnpm doctor 确认。\n");
}

/* ---- 一键初始化 ---- */
if (wantInstall) {
  console.log("== 开始一键初始化 ==\n");
  if (!hasModules) {
    console.log("[setup] 安装前端依赖（pnpm install）...");
    execSync("pnpm install", { cwd: root, stdio: "inherit" });
  } else {
    console.log("[setup] node_modules 已存在，跳过 pnpm install");
  }
  console.log("[setup] 预取 Rust 依赖（cargo fetch，首次较慢）...");
  execSync("cargo fetch", { cwd: root, stdio: "inherit" });
  console.log("[setup] 构建并部署核心插件（pnpm build:core）...");
  execSync("pnpm build:core", { cwd: root, stdio: "inherit" });
  if (!hasBundledPython) {
    console.log("[setup] 下载捆绑 Python 运行时（pnpm fetch:python，需联网）...");
    try {
      execSync("pnpm fetch:python", { cwd: root, stdio: "inherit" });
    } catch {
      console.log("[setup] ⚠️ 捆绑 Python 下载失败（可稍后手动 pnpm fetch:python；dev 回落系统 python）");
    }
  } else {
    console.log("[setup] 捆绑 Python 运行时已存在，跳过下载");
  }
  console.log("\n[setup] 完成。开发命令：pnpm tauri dev");
  console.log("        完整验证：pnpm lint && pnpm build && pnpm test && cargo test --workspace");
}
