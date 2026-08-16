# ToolBox

个人工具箱桌面应用：Rust 核心 + Tauri 2 + React/TypeScript。

笔记、清单、待办、项目文件、AI 整理与博客发布等模块（6 个核心插件自带前端），
详见 [PLAN.md](PLAN.md) 与 [docs/操作手册.md](docs/操作手册.md)。

## 开发

```bash
pnpm install          # 安装前端依赖
pnpm build:core       # 构建核心插件（DLL + 自带前端 ui → %APPDATA% 插件目录）
pnpm tauri dev        # 启动开发模式（弹窗）
```

> 注意：核心插件以 cdylib DLL 形式由宿主加载，`pnpm tauri dev` 前需要先
> `pnpm build:core` 构建并部署（全新克隆后直接 dev 会没有核心插件）。

## 当前状态

- **框架（已完成）**：应用外壳（顶栏/侧栏/状态栏）、设计令牌与亮暗主题（含原生标题栏同步）、系统托盘常驻、桌面半透明浮窗（快速待办 + 全局快捷键 Alt+Q）、自动备份、全文搜索（SQLite FTS5 + 拼音首字母/全拼 + 清单待办内容索引）、导航栏全配置化（分组/排序/标签/图标/隐藏均可配）、自动更新（Tauri updater + GitHub Releases）。
- **6 个核心插件（已完成，全部自带前端）**：笔记（Vditor 即时渲染 + 反链）、待办（浮窗数据层）、清单（打卡/进度/笔记关联）、项目文件管理、博客发布（SSG 生成/内置预览）、AI 整理（OpenAI 兼容对话 + SSE 流式 + 笔记问答 RAG）。
- 插件系统：统一 api 桥（call / on / context / nav / host.search），原生 DLL（FFI）+ 进程（JSON-RPC）+ webview（JS）三类运行时；核心插件可卸载（物理删除 + 标记防复活）、可界面安装（.zip / 目录）。
- **已移除**：数据工具页、记录功能、Git 版本历史（用户决策，不恢复）。

## 发布与自动更新

应用内「设置 → 关于 → 检查更新」从 GitHub Releases 拉取新版本（Tauri updater）。
发布链路：**打 tag → GitHub Actions 构建 → 自动发布**。

```bash
# 1) 改 package.json 的 version → 2) 同步到各处 → 3) 提交打 tag → 4) push 触发 CI
pnpm version:sync                    # 版本单源：tauri.conf.json / version.ts / 8 个 Cargo.toml
git add -A && git commit -m "v0.1.1"
git tag v0.1.1 && git push origin v0.1.1   # 触发 CI（.github/workflows/build-release.yml）
```

首次使用前配置（见 workflow 文件头注释）：
1. 仓库 `Settings → Secrets`：`TAURI_SIGNING_PRIVATE_KEY`（`%USERPROFILE%\.tauri\toolbox-updater.key` 内容）、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
2. `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`：把 `YOUR_NAME/YOUR_REPO` 替换为真实仓库



## 目录

```
src-tauri/     Rust 核心（core 数据层 vault/path/search/backup / plugins 插件管理 / rpc 协议）
src/           前端（themes 主题引擎 / components 组件 / core IPC 与状态）
core-plugins/  6 个核心插件（cdylib DLL + 自带前端 ui/）
tb-sdk/        核心插件 SDK（C ABI 契约 + tb_plugin! 样板宏 + 路径安全）
scripts/       构建与 E2E 脚本（build-core.mjs / cdp-*.mjs 驱动真实 WebView2 验证）
docs/          操作手册、技术栈与概念详解、插件开发指南
```

## 环境要求

- Rust（MSVC 工具链）+ Visual Studio Build Tools（含 C++ 桌面开发）
- Node.js ≥ 20、pnpm
- Windows 10/11（WebView2 运行时）
