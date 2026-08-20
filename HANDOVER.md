# ToolBox 交接文档（Handover）

> **新会话从这里开始**：先读本文件，再读 [PLAN.md](PLAN.md)（规划/里程碑）与
> [docs/操作手册.md](docs/操作手册.md)（功能说明）。本文件只记录"必须知道的事与踩过的坑"。

## 0. 项目一句话

个人工具箱桌面应用：**Rust 核心（Tauri 2）+ Vue 3 宿主 + 插件系统**（6 个核心插件自带前端 +
外部 JS/Python 插件），数据全部是 vault 工作区里的普通文件（Markdown/JSON）。

- 仓库：`D:\WORKSPACE\ToolBox`（远程 `github.com/backunderstar/ToolBox`）
- 语言/工具：Rust 1.97 + Node ≥20 + pnpm 10 + Vue 3.5 + md-editor-v3 + Vite 8（vite-plus/rolldown）

## 1. 技术栈现状（2026 大迁移后）

| 层 | 现状 |
|---|---|
| 宿主前端 `src/` | **Vue 3**（`.vue` SFC + 模块级单例 store），`vue-tsc` 类型检查，`defineAsyncComponent` 懒加载设置页/插件页 |
| 插件 UI `core-plugins/*/ui/` | **全部 Vue 3**（`index.ts` + `App.vue` + `bridge.ts`），Vite lib 构建自包含 IIFE |
| 笔记编辑器 | **md-editor-v3 v6**（不再用 Vditor，`public/vditor/` 已删除） |
| Rust 核心 `src-tauri/` | 零改动迁移；Cargo workspace 根 = 仓库根，`target/` 在仓库根（**不是** src-tauri/target） |
| React | **仓库已无任何 React**（含 devDependencies） |

**分支**：`main` = Vue 3 主线；`react` = React 版冻结存档（只读，勿动）。

## 2. 常用命令

```bash
pnpm env:setup        # 一键初始化：环境检测 + pnpm install + cargo fetch + build:core
pnpm doctor           # 环境检测报告（缺什么、怎么装）
pnpm tauri dev        # 开发模式（**前提**：已 build:core 部署核心插件，否则无核心插件）
pnpm build:core       # 构建核心插件（debug DLL + Vue UI → 应用配置目录 plugins/_core/）
pnpm build:core:release  # release → src-tauri/resources/_core/（打包用）
pnpm build-external-ui plugins/<id>  # 构建外部插件 UI
pnpm sync:plugins     # 仓库 plugins/ → 应用插件目录（开发时同步外部插件改动）
pnpm lint && pnpm build && pnpm test   # 前端验证（lint 必须 0 警告）
cargo test --workspace                 # Rust 测试（78 个）
```

跨平台：`scripts/platform.mjs` 提供 `appDataDir()`（Windows `%APPDATA%` / macOS
`~/Library/Application Support` / Linux `~/.config`），构建/同步脚本均已使用，**不要**再写死 `%APPDATA%`。

## 3. 架构关键点（改代码前必读）

1. **状态层是模块级单例 store**（`src/core/vault.ts` / `plugins.ts` / `navigation.ts`）：
   用 `reactive` + `watch`，组件 `useVault()` 直接拿。Vue 响应式代理读到的永远是当前值——
   **原 React 版的 `stateRef`/`useCallback` 闭包过期防护已不需要**，不要照搬 React 写法。
2. **插件 UI 契约不变**：`window.__TB_PLUGIN_UI__[id] = { mount(el, api), unmount() }`。
   Vue 插件入口：`createApp(App, { api }).mount(el)`；`api` 是宿主导入的桥
   （`call`/`on`/`context`/`nav`/`host.search`，见 `src/core/pluginRuntime.ts`）。
   每个插件 `ui/bridge.ts` 单独定义 `PluginBridgeApi` 类型（**`.vue` 的 `<script setup>` 不能导出类型**）。
3. **宿主与插件 UI 的样式**：插件复用宿主全局 CSS class（`src/styles/*.css`），
   插件自己的样式写 `ui/style.css`（Vite 提取，宿主注入 `<style>`）。
4. **IPC 面**：Rust 命令全在 `src/core/api.ts` 封装；插件命令经 `plugin_call` 统一路由
   （native→FFI / process→JSON-RPC / webview→前端本地注册表）。
5. **懒加载**：SettingsView/PluginsView 是 `defineAsyncComponent`（独立 chunk）；
   插件 UI 本身按需注入（Blob script）。

## 4. 重要决策记录

- 宿主与插件 UI **全 Vue 3**，React 版存档在 `react` 分支（用户决策：以后主要用 Vue 3 开发）
- 笔记编辑器 **Vditor → md-editor-v3**（Vue 3 生态；产物全打进 IIFE，gzip ~702kB，离线可用）
- **插件沙箱**：仅规划在 PLAN.md §5.2（P0：CSP 收紧 + 命令面最小化 + ShadowRealm；P1：iframe + wasm；P2：process 权限 + AppContainer），**未排期未实现**
- 数据/配置目录：业务数据在 vault 工作区；应用配置与插件在应用配置目录（跨平台解析）
- 提交策略：**本地 git 提交，推送需用户确认**；push 后 CI 自动验证

## 5. 坑与注意事项（踩过，别再踩）

### 5.1 终端 / Git（Windows）

- **终端显示中文文件是乱码**（GBK vs UTF-8）：文件内容用 read/grep 工具看，**不要**用 `Get-Content`/`cat` 判断内容。
- **绝不使用 `Set-Content` 写含中文的源文件**（会 GBK 损坏文件）——用 write/edit 工具。
- **中文 commit message**：`git commit -m "中文"` 在 PowerShell 会解析成 pathspec 错误 →
  用 `git commit -F <文件>`（文件放 `target/` 下，gitignored，不会误提交；提交后删掉）。
- **PowerShell 的 exit code 误报**：cargo/git 往 stderr 写内容（linker 警告、进度）时，
  PowerShell 会报 `[exit code: 1]` + NativeCommandError——这是**误报**，用 `$LASTEXITCODE` 判断真实退出码
  （例如 `cargo test 2>$null; Write-Host $LASTEXITCODE`）。
- 提交前 `git add -A` 会带上工作区所有未跟踪文件——注意别把临时文件/产物加进去
  （`plugins/*/ui/index.js`、`core-plugins/*/ui/index.js` 是构建产物，gitignored/已 ignore，勿提交）。

### 5.2 插件 UI 构建

- **`plugin-ui-build.mjs` 必须保留 `define: { "process.env.NODE_ENV": ... }`**：
  md-editor-v3（codemirror 依赖）运行时引用 `process.env`，去掉会报
  `ReferenceError: process is not defined`（冒烟测试第一屏就能抓到）。
- `build-external-ui.mjs` 会把产物复制回插件目录 `ui/`——**core-plugins 不要用
  build-external-ui 构建**（会把 index.js/style.css 复制进源码目录污染 lint；
  用 build:core，产物只在 target/plugin-ui + 部署到应用目录）。
- `core-plugins/blog/ui/style.css`、`notes/ui/style.css` 是 **git 跟踪的源文件**（不是产物），勿删。
- 外部插件 text-stats 的 `plugins/text-stats/ui/index.js` 是 gitignored 产物，构建生成。

### 5.3 依赖 / 工具链

- **archiver 8 是 ESM 重构**：无 default export，用法 `new ZipArchive({ zlib: { level: 9 } })`
  （不是 `archiver("zip")`）。见 `scripts/platform.mjs`。
- **`pnpm setup` 是 pnpm 内置命令**，会遮蔽同名 package.json script——所以初始化脚本叫
  `pnpm env:setup`。
- Windows 上 `execFileSync("pnpm"/"rustc"...)` 不解析 `.cmd` 包装 → 探测用 `execSync` 走 shell
  （见 `dev-env.mjs` 的 tryCmd）。
- `vswhere.exe` 不在 PATH（固定路径 `C:\Program Files (x86)\Microsoft Visual Studio\Installer\`），
  且本机 VS Build Tools 装在**非标准路径** `D:\SDK\Microsoft Visual Studio\18\BuildTools`。
- **TypeScript 7（tsgo，Go 原生）未升级**：生态未就绪，保持 TS 5.x。
- **reqwest 锁 0.13.1**：tauri-updater 约束，勿随意升（0.13.4 已发布但没升）。
- Rust crates 走 rsproxy 镜像（`rsproxy-sparse`），vendored 在 `D:\SDK\Rust\.cargo\registry\...`。

### 5.4 运行时 / 验证

- `pnpm tauri dev` 冒烟验证方式：看终端日志——`[global-error]`/`[unhandled-rejection]`/
  `[resource-error]` 是前端错误转发；`[failed-resources] 无失败资源` 是正常（dev 模式的调试输出）。
- E2E 用 CDP（`--remote-debugging-port=9226`）驱动真实窗口：`scripts/cdp-*.mjs`；
  这些脚本**无法本地自动运行**（需已启动的 dev 实例），改选择器后需手动验证
  （cdp-notes-ui.mjs 的选择器已按 md-editor-v3 更新：`.md-editor` / `.md-editor-content textarea`）。
- 插件 UI 不经 `vue-tsc` 检查（tsconfig include 只有 `src`）——改插件 UI 后靠
  `pnpm build:core` 构建成功 + tauri dev 冒烟验证。

## 6. 未完成 / 待办

- **插件沙箱**（PLAN.md §5.2）：P0 CSP 收紧 + 命令面最小化 + ShadowRealm，未排期
- **md-editor-v3 打磨**：当前为分屏模式（原 Vditor 是即时渲染 IR），如有需要可调
  `md-editor-v3` 配置（工具栏/预览主题/代码高亮主题）
- 13 个 cdp-*.mjs 脚本的样板重复未收敛（`cdp-lib.mjs` 已抽公共，但各套件仍独立）
- 插件 UI 产物体积：notes 含 md-editor-v3 gzip ~702kB（预期内）；如优化可考虑按需拆包
- `scripts/gen-icons.ps1` 是 Windows-only 一次性工具（产物已入库，无需重跑）

## 7. 验证基线（最近一次全绿）

`pnpm doctor` 全就绪 · `pnpm lint` 0 警告 · `pnpm test` 33 · `pnpm build` ·
`pnpm build:core`（6 插件 + DLL 自检）· `cargo test --workspace` 78 ·
`pnpm tauri dev` 冒烟无前端错误。改动后请跑对应子集。
