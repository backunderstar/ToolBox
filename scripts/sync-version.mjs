// 版本单源化：package.json 的 version 是唯一来源，同步到其余各处。
// 升版流程：改 package.json 的 version → `pnpm version:sync` → 提交。
// 同步范围：tauri.conf.json、src/core/version.ts（APP_VERSION/APP_TAG）、
// src-tauri + tb-sdk + 6 个插件的 Cargo.toml（[package] version）。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const v = pkg.version;

// 1. tauri.conf.json
{
  const fp = path.join(root, "src-tauri/tauri.conf.json");
  const conf = JSON.parse(readFileSync(fp, "utf8"));
  conf.version = v;
  writeFileSync(fp, JSON.stringify(conf, null, 2) + "\n", "utf8");
  console.log("[sync-version] tauri.conf.json ->", v);
}

// 2. src/core/version.ts（前端运行时展示，含顶栏 tag 文案）
{
  const fp = path.join(root, "src/core/version.ts");
  const body = `// 应用版本与里程碑标识：由 scripts/sync-version.mjs 从 package.json 同步（版本单源）。
export const APP_VERSION = "${v}";
/** 顶栏 tag 与「关于」展示的统一文案 */
export const APP_TAG = "v${v} · M1–M8 + 备份";
`;
  writeFileSync(fp, body, "utf8");
  console.log("[sync-version] src/core/version.ts ->", v);
}

// 3. Cargo.toml（src-tauri + tb-sdk + 6 插件）
const crates = [
  "src-tauri",
  "tb-sdk",
  "core-plugins/notes",
  "core-plugins/todos",
  "core-plugins/checklists",
  "core-plugins/projects",
  "core-plugins/blog",
  "core-plugins/ai",
];
for (const p of crates) {
  const fp = path.join(root, p, "Cargo.toml");
  const c = readFileSync(fp, "utf8");
  // 只替换第一个 `version = "..."`（[package] 段的 version）。
  // 判断用 test 而非 replace 前后比较：版本未变时 replace 后内容相同会误判未匹配。
  const re = /^(version\s*=\s*)"[^"]*"/m;
  if (!re.test(c)) throw new Error(`未找到 [package] version 字段: ${fp}`);
  writeFileSync(fp, c.replace(re, `$1"${v}"`), "utf8");
  console.log(`[sync-version] ${p}/Cargo.toml ->`, v);
}

console.log("[sync-version] 完成（package.json 为唯一版本来源）");
