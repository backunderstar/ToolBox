# ToolBox

个人工具箱桌面应用：Rust 核心 + Tauri 2 + Vue 3/TypeScript。

笔记、清单、待办、项目文件、AI 整理与博客发布等模块（6 个核心插件自带前端），
详见 [PLAN.md](PLAN.md) 与 [docs/操作手册.md](docs/操作手册.md)。

## 开发（跨平台：Windows / macOS / Linux）

```bash
pnpm env:setup       # 一键初始化：环境检测 + pnpm install + cargo fetch + 部署核心插件
pnpm doctor          # 只检测环境（缺什么、怎么装，含 Linux 系统依赖提示）
pnpm tauri dev       # 启动开发模式（弹窗）
```

> `pnpm env:setup` 会先做环境检测与补齐提示（Node/pnpm/Rust 工具链、平台系统依赖），
> 然后安装前端依赖、预取 Rust 依赖并部署核心插件——全新克隆后直接
> `pnpm env:setup && pnpm tauri dev` 即可。
> 核心插件以 cdylib 形式由宿主加载，`tauri dev` 前必须已构建部署（env:setup 已包含）。
> （脚本名不用 `setup` 是因为 `pnpm setup` 是 pnpm 内置命令，会遮蔽同名 script。）

手动分步（等价于 setup）：

```bash
pnpm install          # 安装前端依赖
pnpm build:core       # 构建核心插件（DLL + 自带前端 ui → 应用配置目录 plugins/_core/）
pnpm tauri dev        # 启动开发模式
```

## 测试与 CI

每次 push / PR 由 GitHub Actions 自动验证（`.github/workflows/ci.yml`）：
lint（oxlint）→ typecheck + 构建 → 前端单测（vitest）→ clippy（`-D warnings`）→
Rust 测试 → 依赖审计（pnpm audit）。本地等效命令：

```bash
pnpm lint && pnpm build && pnpm test    # 前端（lint / typecheck+构建 / vitest）
cargo clippy --workspace --all-targets -- -D warnings   # Rust lint（零告警）
cargo test --workspace                  # Rust 测试（含核心插件与进程桥接测试）
```

## 当前状态

- **框架（已完成）**：应用外壳（顶栏/侧栏/状态栏）、设计令牌与亮暗主题（含原生标题栏同步）、系统托盘常驻、桌面半透明浮窗（快速待办 + 全局快捷键 Alt+Q）、自动备份、全文搜索（SQLite FTS5 + 拼音首字母/全拼 + 清单待办内容索引）、导航栏全配置化（分组/排序/标签/图标/隐藏均可配）、自动更新（Tauri updater + GitHub Releases）。
- **6 个核心插件（已完成，全部自带前端）**：笔记（md-editor-v3 分屏编辑 + 反链）、待办（浮窗数据层）、清单（打卡/进度/笔记关联）、项目文件管理、博客发布（SSG 生成/内置预览）、AI 整理（OpenAI 兼容对话 + SSE 流式 + 笔记问答 RAG）。
- 插件系统：统一 api 桥（call / on / context / nav / host.search），原生 DLL（FFI）+ 进程（JSON-RPC）+ webview（JS）三类运行时；核心插件可卸载（物理删除 + 标记防复活）、可界面安装（.zip / 目录）。
- **已移除**：数据工具页、记录功能、Git 版本历史（用户决策，不恢复）。

## 发布与自动更新

应用内「设置 → 关于 → 检查更新」从 GitHub Releases 拉取新版本（Tauri updater）。
完整流程见 [docs/发布流程.md](docs/发布流程.md)；发布链路：**打 tag → GitHub Actions 构建 → 自动发布**。

```bash
# 1) 改 package.json 的 version → 2) 同步到各处 → 3) 提交打 tag → 4) push 触发 CI
pnpm version:sync                    # 版本单源：tauri.conf.json / version.ts / 8 个 Cargo.toml
git add -A && git commit -m "v0.1.1"
git tag v0.1.1 && git push origin v0.1.1   # 触发 CI（.github/workflows/build-release.yml）
```

首次发布前只需在仓库 `Settings → Secrets` 配置签名密钥（见 docs/发布流程.md）：
`TAURI_SIGNING_PRIVATE_KEY`（`%USERPROFILE%\.tauri\toolbox-updater.key` 内容）、
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。updater endpoints 已指向真实仓库，无需改动。



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

- Node.js ≥ 20、pnpm
- Rust 工具链（rustup：https://rustup.rs）
- **Windows**：Visual Studio Build Tools（含「使用 C++ 的桌面开发」工作负载）+ WebView2（通常随 Windows/Edge 自带）
- **macOS**：Xcode Command Line Tools（`xcode-select --install`）
- **Linux（Debian/Ubuntu 系）**：Tauri 系统依赖，一键安装：
  `sudo apt install build-essential curl wget file libssl-dev libxdo-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev`

> 所有构建/同步/E2E 脚本跨平台通用（scripts/ 为 Node .mjs；应用配置目录按平台自动解析：
> Windows `%APPDATA%` / macOS `~/Library/Application Support` / Linux `~/.config`）。
> `pnpm doctor` 会检测上述各项并给出缺失项的安装命令。
> `scripts/gen-icons.ps1` 是 Windows-only 的一次性图标生成工具（产物已入库，无需重跑）。

## 许可证

[GPL-3.0-or-later](LICENSE)
