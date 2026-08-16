// 构建全部核心插件（cdylib + 自带前端 ui）：
// - 默认（pnpm build:core）：debug DLL + ui → %APPDATA%/com.toolbox.desktop/plugins/_core/<id>/
//   供 dev 运行与 E2E 使用
// - --release（pnpm build:core:release）：release DLL + ui → src-tauri/resources/_core/<id>/
//   打进安装包（bundle.resources），安装后宿主 ensure_core_plugins 部署到 %APPDATA%
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isRelease = process.argv.includes("--release");

const PLUGINS = [
  {
    id: "core-records",
    name: "记录",
    dll: "tb_records.dll",
    description: "核心插件：工作记录（data/records CRUD + 搜索提供者）",
    ui: { entry: "ui/index.js" },
    searchProvider: true,
    nav: [{ id: "records", label: "记录", icon: "notebook", group: "工作区", view: "RecordsView" }],
  },
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
    nav: [{ id: "checklist", label: "清单", icon: "check", group: "工作区", view: "ChecklistView" }],
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
  {
    id: "core-search",
    name: "搜索",
    dll: "tb_search.dll",
    description: "系统插件：全文搜索（SQLite FTS5 索引，横切能力，不可禁用）",
    system: true,
  },
  {
    id: "core-backup",
    name: "备份",
    dll: "tb_backup.dll",
    description: "系统插件：自动备份（快照 + 配置/插件存档 + 恢复，不可禁用）",
    system: true,
  },
];

/** 插件 crate 名：core-blog → tb-blog */
const crateName = (p) => `tb-${p.id.slice(5)}`;

/** 构建插件自带前端（ui/index.tsx → 自包含 IIFE，React 打进产物） */
async function buildPluginUi(p) {
  const uiDir = path.join(root, "core-plugins", p.id.slice(5), "ui");
  const entry = path.join(uiDir, "index.tsx");
  if (!(await exists(entry))) return null; // 无自带前端
  const outDir = path.join(root, "target", "plugin-ui", p.id);
  rmSync(outDir, { recursive: true, force: true });
  await viteBuild({
    configFile: false,
    root,
    plugins: [react()],
    // React 开发版引用 process.env.NODE_ENV：lib 构建需显式替换（否则运行时 ReferenceError）
    define: {
      "process.env.NODE_ENV": JSON.stringify(isRelease ? "production" : "development"),
    },
    build: {
      outDir,
      emptyOutDir: true,
      lib: { entry, formats: ["iife"], name: "TBPluginUi" },
      rollupOptions: {
        output: { entryFileNames: "index.js", assetFileNames: "style.css" },
      },
    },
  });
  return outDir;
}

const exists = (p) => import("node:fs").then((fs) => fs.promises.access(p).then(() => true).catch(() => false));

const profile = isRelease ? "release" : "debug";
// 打包资源目录始终存在（tauri build.rs 检查 resources/_core；release 填充 DLL）
mkdirSync(path.join(root, "src-tauri", "resources", "_core"), { recursive: true });
console.log(`[build-core] 构建核心插件（${profile}）...`);
execSync(
  `cargo build --manifest-path "${path.join(root, "Cargo.toml")}"${isRelease ? " --release" : ""}`,
  { stdio: "inherit" }
);

// 输出目录：release → 打包资源（src-tauri/resources/_core）；debug → %APPDATA%
let coreRoot;
if (isRelease) {
  coreRoot = path.join(root, "src-tauri", "resources", "_core");
  rmSync(coreRoot, { recursive: true, force: true });
} else {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  coreRoot = path.join(appData, "com.toolbox.desktop", "plugins", "_core");
}

for (const p of PLUGINS) {
  const target = path.join(coreRoot, p.id);
  mkdirSync(target, { recursive: true });
  cpSync(path.join(root, "target", profile, p.dll), path.join(target, p.dll));

  // 自带前端：构建产物复制到插件目录 ui/
  if (p.ui) {
    const built = await buildPluginUi(p);
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
    version: "0.1.0",
    runtime: "native",
    command: [p.dll],
    description: p.description,
    searchProvider: p.searchProvider ?? false,
    system: p.system ?? false,
    ui: p.ui ?? null,
    nav: p.nav ?? [],
  };
  writeFileSync(path.join(target, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[build-core] 已部署: ${p.id} → ${target}`);
}
