// 版本单源化：package.json 的 version 是唯一来源，同步到其余各处。
// 用法：
//   pnpm version:sync                   升版流程：改 package.json version → 同步各处
//   node scripts/sync-version.mjs --check   只校验不写文件（CI：版本漂移即失败）
// 同步范围：tauri.conf.json、src/core/version.ts（APP_VERSION）、
// src-tauri + tb-sdk + 6 个插件的 Cargo.toml（[package] version）。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isCheck = process.argv.includes("--check");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const v = pkg.version;

/** 收集漂移项（check 模式）或直接同步（普通模式）。 */
const drift = [];
const sync = (label, actual, write) => {
  if (isCheck) {
    if (actual !== v) drift.push(`${label}: ${actual ?? "(缺失)"}（应为 ${v}）`);
    return;
  }
  write();
  console.log(`[sync-version] ${label} ->`, v);
};

// 1. tauri.conf.json
{
  const fp = path.join(root, "src-tauri/tauri.conf.json");
  const conf = JSON.parse(readFileSync(fp, "utf8"));
  sync(
    "src-tauri/tauri.conf.json version",
    conf.version,
    () => writeFileSync(fp, JSON.stringify({ ...conf, version: v }, null, 2) + "\n", "utf8"),
  );
}

// 2. src/core/version.ts（前端运行时展示，含顶栏 tag 文案）
{
  const fp = path.join(root, "src/core/version.ts");
  const body = readFileSync(fp, "utf8");
  const m = body.match(/APP_VERSION = "([^"]+)"/);
  sync(
    "src/core/version.ts APP_VERSION",
    m?.[1],
    () =>
      writeFileSync(
        fp,
        `// 应用版本与里程碑标识：由 scripts/sync-version.mjs 从 package.json 同步（版本单源）。
export const APP_VERSION = "${v}";
/** 顶栏 tag 与「关于」展示的统一文案（用户决策：只显示版本号，不带里程碑文案） */
export const APP_TAG = "v${v}";
`,
        "utf8",
      ),
  );
}

// 3. Cargo.toml（src-tauri + tb-sdk + 核心插件）
const crates = ["src-tauri", "tb-sdk", "core-plugins/example", "core-plugins/probe-rat-layer"];
for (const p of crates) {
  const fp = path.join(root, p, "Cargo.toml");
  const c = readFileSync(fp, "utf8");
  // 只匹配第一个 `version = "..."`（[package] 段的 version）
  const m = c.match(/^version\s*=\s*"([^"]*)"/m);
  if (!m) {
    if (isCheck) {
      drift.push(`${p}/Cargo.toml: 未找到 [package] version 字段`);
      continue;
    }
    throw new Error(`未找到 [package] version 字段: ${fp}`);
  }
  sync(
    `${p}/Cargo.toml version`,
    m[1],
    () => writeFileSync(fp, c.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${v}"`), "utf8"),
  );
}

if (isCheck) {
  if (drift.length > 0) {
    console.error(`[sync-version] --check 失败：版本漂移\n  - ${drift.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("[sync-version] --check 通过（各处版本与 package.json 一致）");
} else {
  console.log("[sync-version] 完成（package.json 为唯一版本来源）");
}
