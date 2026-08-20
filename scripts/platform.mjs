// platform.mjs — 跨平台开发环境工具库（Node ≥ 20，Windows/macOS/Linux 通用）。
//
// 用途：脚本层（构建/同步/E2E）不再硬编码 Windows 路径与命令；
// 应用配置目录与 Rust 侧 tauri path API 语义保持一致。
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";
/** 平台名（tauri 的 target triple 前缀，日志/提示用） */
export const platformName = isWindows ? "windows" : isMac ? "macos" : "linux";

const APP_ID = "com.toolbox.desktop";

/**
 * 应用配置目录（与 Rust 侧 `app.path().app_config_dir()` 一致）：
 *   Windows: %APPDATA%/com.toolbox.desktop
 *   macOS:   ~/Library/Application Support/com.toolbox.desktop
 *   Linux:   $XDG_CONFIG_HOME/com.toolbox.desktop（默认 ~/.config/…）
 */
export function appDataDir() {
  if (isWindows) {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), APP_ID);
  }
  if (isMac) {
    return path.join(os.homedir(), "Library", "Application Support", APP_ID);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), APP_ID);
}

/** 应用全局插件目录（外部插件 + _core 核心插件） */
export function pluginsDir() {
  return path.join(appDataDir(), "plugins");
}

/** 核心插件（cdylib）部署目录 */
export function corePluginsDir() {
  return path.join(pluginsDir(), "_core");
}

/**
 * 把目录压缩为 .zip（跨平台）。
 * 优先 Node 库 archiver（纯 JS，三平台行为一致）；未安装时回退系统命令
 * （Windows/macOS 自带 bsdtar：`tar -a`；Linux 的 `zip`）。
 * zip 内顶层目录名 = srcDir 的 basename（与 Windows Compress-Archive 一致）。
 * @param {string} srcDir 要压缩的目录（含顶层目录）
 * @param {string} zipPath 输出 .zip 路径
 */
export async function zipDirectory(srcDir, zipPath) {
  try {
    const { ZipArchive } = await import("archiver");
    await new Promise((resolve, reject) => {
      const out = createWriteStream(zipPath);
      // archiver 8（ESM 重构）：ZipArchive 独立类，构造参数即格式选项
      const archive = new ZipArchive({ zlib: { level: 9 } });
      out.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(out);
      archive.directory(srcDir, path.basename(srcDir));
      archive.finalize();
    });
    return;
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e; // archiver 已装但压缩失败 → 抛
    // 未安装 archiver（未跑 pnpm install）：回退系统命令
    if (isWindows || isMac) {
      execFileSync("tar", ["-a", "-c", "-f", zipPath, "-C", path.dirname(srcDir), path.basename(srcDir)], { stdio: "ignore" });
    } else {
      execFileSync("zip", ["-rq", zipPath, path.basename(srcDir)], { cwd: path.dirname(srcDir) });
    }
  }
}
