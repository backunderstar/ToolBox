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

const PLUGINS = [
  {
    id: "core-notes",
    name: "笔记",
    dll: "tb_notes.dll",
    description: "核心插件：笔记文件操作（notes/ 列表/读写/新建/删除/重命名）",
    ui: { entry: "ui/index.js" },
    nav: [{ id: "notes", label: "笔记", icon: "file-text", group: "工作区", view: "NotesView" }],
  },
  {
    id: "core-todos",
    name: "待办",
    dll: "tb_todos.dll",
    description: "核心插件：快速待办（vault/data/todos/todos.json，浮窗数据层）",
    ui: { entry: "ui/index.js" },
  },
  {
    id: "core-checklists",
    name: "清单",
    dll: "tb_checklists.dll",
    description: "核心插件：清单（data/checklists CRUD）",
    ui: { entry: "ui/index.js" },
    nav: [
      { id: "checklist", label: "清单", icon: "check", group: "工作区", view: "ChecklistView" },
    ],
  },
  {
    id: "core-projects",
    name: "项目",
    dll: "tb_projects.dll",
    description: "核心插件：项目文件管理（projects/ 目录/归档/默认应用打开）",
    ui: { entry: "ui/index.js" },
    nav: [{ id: "projects", label: "项目", icon: "folder", group: "工作区", view: "ProjectsView" }],
  },
  {
    id: "core-blog",
    name: "博客",
    dll: "tb_blog.dll",
    description: "核心插件：博客发布（frontmatter/站点生成/内置预览服务器）",
    ui: { entry: "ui/index.js" },
    nav: [{ id: "blog", label: "博客发布", icon: "globe", group: "系统", view: "BlogView" }],
  },
  {
    id: "core-ai",
    name: "AI",
    dll: "tb_ai.dll",
    description: "核心插件：AI 整理（OpenAI 兼容对话 + SSE 流式 + keyring 凭据）",
    ui: { entry: "ui/index.js" },
    nav: [{ id: "ai", label: "AI 整理", icon: "sparkle", group: "系统", view: "AIChatView" }],
  },
];

// 注：core-search / core-backup 已迁回宿主本体框架（core/search.rs + core/backup.rs，
// 系统级横切能力不作为可装卸插件），不再在此构建部署。

/** 构建核心插件自带前端（ui/index.ts → 自包含 IIFE，Vue 3 打进产物；
 *  兼容遗留 index.tsx 入口）。
 *  vite 构建部分走公共构建器（scripts/plugin-ui-build.mjs，与 build-external-ui
 *  共用）；本函数只负责定位入口/校验与路径换算。 */
async function buildCorePluginUi(p) {
  const uiDir = path.join(root, "core-plugins", p.id.slice(5), "ui");
  const entryTs = path.join(uiDir, "index.ts");
  const entryTsx = path.join(uiDir, "index.tsx");
  const entry = (await exists(entryTs)) ? entryTs : entryTsx;
  if (!(await exists(entry))) {
    // 声明了 ui 却缺源文件：静默跳过会部署"声明 ui 但无产物"的坏清单，
    // 运行时挂载失败且难排查——直接抛错暴露问题
    if (p.ui) {
      throw new Error(`[build-core] ${p.id} 声明了 ui.entry 但缺少源码: ${entry}`);
    }
    return null; // 未声明 ui 的正常插件
  }
  const outDir = path.join(root, "target", "plugin-ui", p.id);
  await buildPluginUi({
    root,
    entry,
    outDir,
    env: isRelease ? "production" : "development",
  });
  return outDir;
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
// 只编 6 个插件 cdylib（-p 限定）：宿主 app / tb-sdk 是它们的依赖会被自动带上，
// 但不构建宿主二进制——避免 beforeBuildCommand 阶段白编译整个宿主应用
execSync(
  `cargo build --manifest-path "${path.join(root, "Cargo.toml")}" -p tb-notes -p tb-todos -p tb-checklists -p tb-projects -p tb-blog -p tb-ai${isRelease ? " --release" : ""}`,
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
      if (built) {
        const uiTarget = path.join(target, "ui");
        mkdirSync(uiTarget, { recursive: true });
        for (const f of ["index.js", "style.css"]) {
          const s = path.join(built, f);
          if (await exists(s)) cpSync(s, path.join(uiTarget, f));
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
