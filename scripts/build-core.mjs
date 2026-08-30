// 构建全部核心插件（cdylib + 自带前端 ui）：
// - 默认（pnpm build:core）：debug DLL + ui → 应用配置目录 plugins/_core/<id>/
//   供 dev 运行与 E2E 使用（Windows %APPDATA% / macOS ~/Library/Application Support / Linux ~/.config）
// - --release（pnpm build:core:release）：release DLL + ui → src-tauri/resources/_core/<id>/
//   打进安装包（bundle.resources），安装后宿主 ensure_core_plugins 部署到应用配置目录
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginUi } from "./plugin-ui-build.mjs";
import { corePluginsDir } from "./platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isRelease = process.argv.includes("--release");
// 版本单源：插件 manifest 的 version 读自 package.json（升版只改一处，见 sync-version.mjs）
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const VERSION = pkg.version;

// 教学基线：核心插件仅保留一个教学示例（core-example）。
// 新增核心插件：在 core-plugins/<id>/ 写 crate + ui/，然后往 PLUGINS 加一项即可
// （manifest 由本脚本生成，含 bundled 标记；id 必须与 core-plugins/<id> 目录对应）。
const PLUGINS = [
  {
    id: "core-example",
    name: "示例插件",
    dll: "tb_example.dll",
    description: "核心插件教学示例：命令/事件/搜索提供者/宿主能力/自带前端/外壳扩展点全覆盖",
    ui: { entry: "ui/index.js" },
    nav: [{ id: "example", label: "示例插件", icon: "puzzle", group: "工作区" }],
    searchProvider: true,
    // 宿主外壳动作：顶栏按钮 + 托盘菜单项（统一交互见插件开发指南 §宿主外壳扩展点）
    actions: [
      { id: "greet", label: "示例问候", icon: "puzzle", topbar: true, tray: true },
      { id: "open", label: "打开示例界面", icon: "file-text", topbar: false, tray: true },
    ],
    // 设置页插件段：构建 ui/settings.ts → ui/settings.js，设置页「插件设置」段挂载
    settings: { entry: "ui/settings.js" },
    // 桌面浮窗界面：构建 ui/float.ts → ui/float.js，启用后浮窗（Alt+Q）显示本界面
    float: { entry: "ui/float.js" },
    // 教学点：manifest config 会注入 tb_create 的 cfg（示例读取 author 回显）
    config: { author: "ToolBox 教程" },
  },
];

// 注：core-search / core-backup 已迁回宿主本体框架（core/search.rs + core/backup.rs，
// 系统级横切能力不作为可装卸插件），不再在此构建部署。

/** 构建核心插件自带前端（ui/index.ts → 自包含 IIFE，Vue 3 打进产物；
 *  兼容遗留 index.tsx 入口）。
 *  支持多入口：主界面 ui/index.ts（产物 index.js）+ 可选设置面板 ui/settings.ts
 *  （产物 settings.js，对应 manifest settings.entry）。
 *  vite 构建部分走公共构建器（scripts/plugin-ui-build.mjs，与 build-external-ui
 *  共用）；本函数只负责定位入口/校验与路径换算。
 *  @returns {Promise<Array<{outDir: string, jsName: string}>>} 各入口产物目录与目标 js 名 */
async function buildCorePluginUi(p) {
  const uiDir = path.join(root, "core-plugins", p.id.slice(5), "ui");
  const outDir = path.join(root, "target", "plugin-ui", p.id);
  const env = isRelease ? "production" : "development";
  const built = [];
  // 主界面入口 ui/index.ts(x)
  const entryTs = path.join(uiDir, "index.ts");
  const entryTsx = path.join(uiDir, "index.tsx");
  const entry = (await exists(entryTs)) ? entryTs : entryTsx;
  if (await exists(entry)) {
    const out = path.join(outDir, "main");
    await buildPluginUi({ root, entry, outDir: out, env });
    built.push({ outDir: out, jsName: "index" });
  }
  // 可选设置面板入口 ui/settings.ts（manifest settings.entry = ui/settings.js）
  const settingsTs = path.join(uiDir, "settings.ts");
  if (await exists(settingsTs)) {
    const out = path.join(outDir, "settings");
    await buildPluginUi({ root, entry: settingsTs, outDir: out, env });
    built.push({ outDir: out, jsName: "settings" });
  }
  // 可选桌面浮窗入口 ui/float.ts（manifest float.entry = ui/float.js）
  const floatTs = path.join(uiDir, "float.ts");
  if (await exists(floatTs)) {
    const out = path.join(outDir, "float");
    await buildPluginUi({ root, entry: floatTs, outDir: out, env });
    built.push({ outDir: out, jsName: "float" });
  }
  if (built.length === 0 && p.ui) {
    // 声明了 ui 却缺源文件：静默跳过会部署"声明 ui 但无产物"的坏清单，
    // 运行时挂载失败且难排查——直接抛错暴露问题
    throw new Error(`[build-core] ${p.id} 声明了 ui.entry 但缺少源码: ${entry}`);
  }
  return built;
}

const exists = (p) =>
  import("node:fs").then((fs) =>
    fs.promises
      .access(p)
      .then(() => true)
      .catch(() => false),
  );

const profile = isRelease ? "release" : "debug";
// 打包资源目录始终存在（tauri build.rs 检查 resources/_core；release 填充 DLL）
mkdirSync(path.join(root, "src-tauri", "resources", "_core"), { recursive: true });
console.log(`[build-core] 构建核心插件（${profile}）...`);
// 只编插件 cdylib（-p 限定）：宿主 app / tb-sdk 是它们的依赖会被自动带上，
// 但不构建宿主二进制——避免 beforeBuildCommand 阶段白编译整个宿主应用
execSync(
  `cargo build --manifest-path "${path.join(root, "Cargo.toml")}" -p tb-example${isRelease ? " --release" : ""}`,
  { stdio: "inherit" },
);

// 输出目录：release → 打包资源（src-tauri/resources/_core）；debug → 应用配置目录
let coreRoot;
if (isRelease) {
  coreRoot = path.join(root, "src-tauri", "resources", "_core");
  rmSync(coreRoot, { recursive: true, force: true });
} else {
  coreRoot = corePluginsDir();
}
mkdirSync(coreRoot, { recursive: true });
// 清理已不在 PLUGINS 中的旧随包插件目录（如迁回宿主的 core-search / core-backup）。
// 只删"随包插件"（plugin.json 带 bundled 标记，见下方 manifest）——用户手动安装的
// 插件目录必须保留：dev 构建不能清掉用户放进去的 DLL 插件（与 release 的
// deploy_core_plugins "保留用户插件" 语义对齐）。
{
  const keep = new Set(PLUGINS.map((p) => p.id));
  for (const name of readdirSync(coreRoot)) {
    if (!keep.has(name)) {
      const manifestPath = path.join(coreRoot, name, "plugin.json");
      let bundled = false;
      try {
        bundled = JSON.parse(readFileSync(manifestPath, "utf8")).bundled === true;
      } catch {
        bundled = false; // 无清单/清单损坏：一律视为手动插件，保留
      }
      if (bundled) {
        rmSync(path.join(coreRoot, name), { recursive: true, force: true });
        console.log(`[build-core] 清理已移除随包插件: ${name}`);
      } else {
        console.log(`[build-core] 保留手动安装插件: ${name}`);
      }
    }
  }
}

// UI 构建互相独立（各自 viteBuild 到 target/plugin-ui/<id>）：并行跑，省总时长
await Promise.all(
  PLUGINS.map(async (p) => {
    const target = path.join(coreRoot, p.id);
    mkdirSync(target, { recursive: true });
    cpSync(path.join(root, "target", profile, p.dll), path.join(target, p.dll));

    // 自带前端：构建产物复制到插件目录 ui/
    if (p.ui) {
      const built = await buildCorePluginUi(p);
      const uiTarget = path.join(target, "ui");
      mkdirSync(uiTarget, { recursive: true });
      for (const { outDir, jsName } of built) {
        // 各入口产物：index.js / settings.js（style.css 只随主入口复制）
        const s = path.join(outDir, "index.js");
        if (await exists(s)) cpSync(s, path.join(uiTarget, `${jsName}.js`));
        if (jsName === "index") {
          const ss = path.join(outDir, "style.css");
          if (await exists(ss)) cpSync(ss, path.join(uiTarget, "style.css"));
        }
      }
    }

    const manifest = {
      id: p.id,
      name: p.name,
      version: VERSION,
      runtime: "native",
      command: [p.dll],
      description: p.description,
      searchProvider: p.searchProvider ?? false,
      system: p.system ?? false,
      ui: p.ui ?? null,
      nav: p.nav ?? [],
      // 宿主外壳动作（顶栏按钮 / 托盘菜单项；统一交互见插件开发指南 §宿主外壳扩展点）
      actions: p.actions ?? [],
      // 设置页插件段（ui/settings.js 产物；插件自定义设置面板）
      settings: p.settings ?? null,
      // 桌面浮窗界面（ui/float.js 产物；启用后浮窗显示本插件界面）
      float: p.float ?? null,
      // 教学点：manifest config 注入 tb_create 的 cfg（插件读取；宿主会合并 vault 等运行期键）
      config: p.config ?? {},
      // 随包插件标记：dev 构建清理时据此识别"可清理的旧随包插件"，
      // 不误删用户手动安装的插件目录（宿主解析清单时忽略未知字段）
      bundled: true,
    };
    writeFileSync(path.join(target, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
    console.log(`[build-core] 已部署: ${p.id} → ${target}`);
  }),
);

// 部署后自检：每个插件目录必须有 plugin.json 与 DLL（漏部署/坏清单应在构建期暴露，
// 而不是等到安装包跑起来才发现"核心插件缺失"）。
for (const p of PLUGINS) {
  const target = path.join(coreRoot, p.id);
  if (!(await exists(path.join(target, "plugin.json")))) {
    throw new Error(`[build-core] 自检失败: ${p.id}/plugin.json 缺失（部署异常）`);
  }
  if (!(await exists(path.join(target, p.dll)))) {
    throw new Error(`[build-core] 自检失败: ${p.id}/${p.dll} 缺失（DLL 未构建）`);
  }
}
console.log(`[build-core] 自检通过: ${PLUGINS.length} 个插件均含 plugin.json + DLL`);
