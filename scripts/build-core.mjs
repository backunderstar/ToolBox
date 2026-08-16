// 构建核心插件（cdylib）并部署到 %APPDATA%/com.toolbox.desktop/plugins/_core/<id>/
// 供宿主 PluginManager 扫描（_core 子目录）与 E2E 使用。
// 用法：pnpm build:core
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "Cargo.toml");

console.log("[build-core] 构建核心插件...");
execSync(`cargo build --manifest-path "${manifestPath}" -p tb-records`, {
  stdio: "inherit",
});

const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const target = path.join(appData, "com.toolbox.desktop", "plugins", "_core", "core-records");
mkdirSync(target, { recursive: true });
cpSync(path.join(root, "target", "debug", "tb_records.dll"), path.join(target, "tb_records.dll"));

const manifest = {
  id: "core-records",
  name: "记录",
  version: "0.1.0",
  runtime: "native",
  command: ["tb_records.dll"],
  description: "核心插件：工作记录（data/records CRUD + 搜索提供者）",
  searchProvider: true,
  nav: [
    { id: "records", label: "记录", icon: "notebook", group: "工作区", view: "RecordsView" },
  ],
};
writeFileSync(path.join(target, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log("[build-core] 已部署:", target);
