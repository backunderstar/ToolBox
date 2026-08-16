// 构建全部核心插件（cdylib）并部署到 %APPDATA%/com.toolbox.desktop/plugins/_core/<id>/
// 供宿主 PluginManager 扫描（_core 子目录）与 E2E 使用。
// 用法：pnpm build:core
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLUGINS = [
  {
    id: "core-records",
    name: "记录",
    dll: "tb_records.dll",
    description: "核心插件：工作记录（data/records CRUD + 搜索提供者）",
    searchProvider: true,
    nav: [{ id: "records", label: "记录", icon: "notebook", group: "工作区", view: "RecordsView" }],
  },
  {
    id: "core-notes",
    name: "笔记",
    dll: "tb_notes.dll",
    description: "核心插件：笔记文件操作（notes/ 列表/读写/新建/删除/重命名）",
    nav: [{ id: "notes", label: "笔记", icon: "file-text", group: "工作区", view: "NotesView" }],
  },
  {
    id: "core-todos",
    name: "待办",
    dll: "tb_todos.dll",
    description: "核心插件：快速待办（vault/data/todos/todos.json，浮窗数据层）",
  },
  {
    id: "core-checklists",
    name: "清单",
    dll: "tb_checklists.dll",
    description: "核心插件：清单（data/checklists CRUD）",
    nav: [{ id: "checklist", label: "清单", icon: "check", group: "工作区", view: "ChecklistView" }],
  },
  {
    id: "core-projects",
    name: "项目",
    dll: "tb_projects.dll",
    description: "核心插件：项目文件管理（projects/ 目录/归档/默认应用打开）",
    nav: [{ id: "projects", label: "项目", icon: "folder", group: "工作区", view: "ProjectsView" }],
  },
  {
    id: "core-blog",
    name: "博客",
    dll: "tb_blog.dll",
    description: "核心插件：博客发布（frontmatter/站点生成/内置预览服务器）",
    nav: [{ id: "blog", label: "博客发布", icon: "globe", group: "系统", view: "BlogView" }],
  },
  {
    id: "core-ai",
    name: "AI",
    dll: "tb_ai.dll",
    description: "核心插件：AI 整理（OpenAI 兼容对话 + SSE 流式 + keyring 凭据）",
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

console.log("[build-core] 构建核心插件...");
execSync(`cargo build --manifest-path "${path.join(root, "Cargo.toml")}"`, { stdio: "inherit" });

const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
const coreRoot = path.join(appData, "com.toolbox.desktop", "plugins", "_core");

for (const p of PLUGINS) {
  const target = path.join(coreRoot, p.id);
  mkdirSync(target, { recursive: true });
  cpSync(path.join(root, "target", "debug", p.dll), path.join(target, p.dll));
  const manifest = {
    id: p.id,
    name: p.name,
    version: "0.1.0",
    runtime: "native",
    command: [p.dll],
    description: p.description,
    searchProvider: p.searchProvider ?? false,
    system: p.system ?? false,
    nav: p.nav ?? [],
  };
  writeFileSync(path.join(target, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`[build-core] 已部署: ${p.id}`);
}
