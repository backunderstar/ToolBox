# ToolBox 交接文档（Handover）

> **新会话从这里开始**：先读本文件（按重要度排序，第一节是最紧急的事）。
> 规划/里程碑见 [PLAN.md](PLAN.md)，功能说明见 [docs/操作手册.md](docs/操作手册.md)。
> 本文件只记录"必须知道的事与踩过的坑"。

---

## 1. 🔴 当前状态：捆绑 Python 运行时（✅ 核心链路已完成，含 dev 冒烟 + 打包验证 + 安装依赖按钮）

**目标**（用户已确认方案 A + full 变体）：目标机没装 Python 也能跑 process 插件
（csv-tool / py-tools）。**全部链路已实现并验证**：cargo 81 测试 / lint 0 / test 33 / build ✓、
dev 冒烟（csv-tool/py-tools 均确认使用捆绑解释器）、打包版冒烟（无 Python PATH 下
部署捆绑运行时 + 两插件用捆绑解释器）、插件页"安装依赖"按钮已上线。
剩余：文档/交接收尾与提交（勿推送）。

### 1.1 完成状态（2026-08-29）

- `src-tauri/resources/python/` 已就位：Python 3.14.7 + pip 26.2.1，**瘦身后 48.7MB**
  （原 180MB：删 pdb 调试符号 ~90MB + Lib/test ~32MB + 字节码缓存）
- **8/21 写的 11 个文件已在 8/26 被提交为 `5a895b7`**（非本人提交，内容 = 8/21 会话的代码）
- **8/28 提交**：`0f4fbee`（捆绑 Python 收尾——镜像下载/瘦身 + 0xC0000139 修复）、
  `2668065`（清理无用文件/整理文档）、`885ea83`（CI 修复 resources/python 校验）、
  `f2c9e06`（docs: 记录待推送提交与网络情况）
- **8/29（本轮）改动**：插件页"安装依赖"按钮（后端 `plugins_install_deps` 命令 +
  `PluginInfo.hasDeps` 标记 + 前端按钮/结果面板）、`start_process` 增解释器日志
  （`[plugin] <id> 解释器: <路径> (捆绑/自带|系统 PATH 回落)`，冒烟验证用）、
  py-tools 增 `requirements.txt` 示例、docs 四件套收尾（PLAN §5.1 / README / 操作手册 / 插件开发指南 §3.5）

### 1.2 验证结果（2026-08-29 实测）

1. **dev 冒烟** ✅：`pnpm tauri dev` 日志两条 `[plugin] csv-tool/py-tools 解释器:
   ...target\debug\resources\python\python.exe (捆绑/自带)`（dev 下 tauri 把
   resources/python 拷进 target/debug/resources/，`bundled_python_dir` 经 exe 相对路径解析到）
2. **打包验证** ✅：`build:core:release` + `tauri build --debug --no-bundle` →
   以**剔除 python 的 PATH** 运行 `target\debug\toolbox.exe`：日志出现
   `[python] 已部署捆绑 Python 运行时到 %APPDATA%\com.toolbox.desktop\python` +
   `[plugin] 已部署随应用分发的核心插件` + 两插件解释器均指向捆绑运行时（部署线程与
   预热 refresh 竞态时回落资源目录路径，同样是捆绑运行时，目标机行为一致）
3. **安装依赖流程** ✅：手动用捆绑 python 跑 `pip install --target vendor -r requirements.txt`
   实测 EXIT=0（Successfully installed python-dateutil six）；按钮 UI 的交互点击留待用户验收
4. 基线：cargo 81 / lint 0 / test 33 / build ✓ / build:core:release 自检 6 插件+DLL ✓

### 1.3 设计（改动前先看懂）

- **两层模型**：全局捆绑解释器（随包分发，部署到 `%APPDATA%/com.toolbox.desktop/python/`）
  + 插件级自包含（`vendor/` → `env/` → 插件目录自带 `python.exe`，逐级升级）
- **宿主解释器三级解析**（`pyruntime::resolve_interpreter`）：
  插件目录 `python.exe` → 全局捆绑 → 系统 PATH
- **缺依赖可读报错**：插件 stderr 从 `inherit` 改为 piped 捕获（读线程转发日志 + 保留最近
  40 行），init 失败时把 Python traceback 附到插件错误信息里
- **安装依赖按钮**：`plugins_install_deps` 命令——捆绑 python
  `pip install --disable-pip-version-check --no-input --target <插件>/vendor -r requirements.txt`
  （输出落临时文件再读尾部 40 行，10 分钟超时轮询 try_wait）；`PluginInfo.hasDeps` =
  插件目录存在 requirements.txt，仅 process 插件显示按钮；前端成功后自动 `reload` 插件生效

### 1.4 已改文件（8/21 部分已提交 5a895b7；⭐ 为本轮新改；本表为全量）

| 文件 | 改动 |
|---|---|
| `scripts/fetch-python.mjs`（新） | GitHub API 取最新 release → 匹配 `cpython-3.14.*-x86_64-pc-windows-msvc-pgo-full.tar.zst` → 下载 + SHA256SUMS 校验 → bsdtar 解压 → **瘦身**；`--version`/`--force`/`--mirror https://ghfast.top/`（镜像选项） |
| `package.json` | `fetch:python` 脚本 |
| `.gitignore` | `src-tauri/resources/python/` |
| `src-tauri/tauri.conf.json` | `bundle.resources` += `resources/python` |
| `src-tauri/src/plugins/pyruntime.rs`（新） | `ensure_bundled_python`（仅 release 部署）、`deploy_bundled_python`、`bundled_python_dir`、`resolve_interpreter`（改收纯路径，不再收 AppHandle）、`is_python_command` + 3 单测 |
| `src-tauri/src/plugins/mod.rs` | `pub mod pyruntime` + `#[cfg(not(dev))]` re-export |
| `src-tauri/src/plugins/manager.rs` | `PluginManager` 存**缓存的捆绑目录路径**（`bundled_python: Option<PathBuf>`，不存 AppHandle——崩溃修复）；`start_process` 接入解析 + spawn 失败提示 + init 失败附 stderr 末尾；⭐ 新增 `install_deps`（pip install --target vendor）+ `PluginInfo.has_deps` + `tail_lines` + `[plugin] <id> 解释器` 日志 |
| `src-tauri/src/plugins/process.rs` | stderr piped 捕获（`read_stderr_loop` + `stderr_tail()`） |
| `src-tauri/src/plugins/commands.rs` | ⭐ 新增 `plugins_install_deps` 命令（vault S1c + id S1a 校验，spawn_blocking） |
| `src-tauri/src/lib.rs` | setup 的 `cfg(not(dev))` 块先 spawn `ensure_bundled_python` 再 `ensure_core_plugins`；⭐ 注册 `plugins_install_deps` |
| `scripts/dev-env.mjs` | doctor 新增"捆绑 Python 运行时"检查；env:setup 缺失时自动 fetch（失败仅警告） |
| `src/core/api.ts` | ⭐ `PluginInfo.hasDeps` + `pluginsInstallDeps` |
| `src/components/PluginCard.vue` | ⭐ "安装依赖"按钮（process + hasDeps 显示，depsBusy 禁用） |
| `src/components/PluginsView.vue` | ⭐ `doInstallDeps`（装完自动 reload）+ 结果面板（pip 输出尾部） |
| `src/styles/notes.css` | ⭐ `.deps-output` 样式 |
| `plugins/py-tools/requirements.txt`（新） | ⭐ vendored 依赖声明示例（python-dateutil；构建机/按钮通用） |
| `docs/插件开发指南.md`、`docs/操作手册.md`、`README.md`、`PLAN.md` | ⭐ §3.5/§6.1/README/§5.1 补安装依赖按钮与验证结果 |

---

## 2. 项目一句话

个人工具箱桌面应用：**Rust 核心（Tauri 2）+ Vue 3 宿主 + 插件系统**（6 个核心插件自带前端 +
外部 JS/Python 插件），数据全部是 vault 工作区里的普通文件（Markdown/JSON）。

- 仓库：`D:\WORKSPACE\ToolBox`（远程 `github.com/backunderstar/ToolBox`）
- 语言/工具：Rust 1.97 + Node ≥20 + pnpm 10 + Vue 3.5 + md-editor-v3 + Vite 8（vite-plus/rolldown）
- **分支**：`main` = Vue 3 主线；`react` = React 版冻结存档（只读，勿动）

## 3. 技术栈现状（2026 大迁移后）

| 层 | 现状 |
|---|---|
| 宿主前端 `src/` | **Vue 3**（`.vue` SFC + 模块级单例 store），`vue-tsc` 类型检查，`defineAsyncComponent` 懒加载设置页/插件页 |
| 插件 UI `core-plugins/*/ui/` | **全部 Vue 3**（`index.ts` + `App.vue` + `bridge.ts`），Vite lib 构建自包含 IIFE |
| 笔记编辑器 | **md-editor-v3 v6**（不再用 Vditor，`public/vditor/` 已删除） |
| Rust 核心 `src-tauri/` | Cargo workspace 根 = 仓库根，`target/` 在仓库根（**不是** src-tauri/target） |
| React | **仓库已无任何 React**（含 devDependencies） |

## 4. 常用命令

```bash
pnpm env:setup        # 一键初始化：环境检测 + pnpm install + cargo fetch + build:core + fetch:python
pnpm doctor           # 环境检测报告（缺什么、怎么装）
pnpm tauri dev        # 开发模式（前提：已 build:core 部署核心插件）
pnpm build:core       # 构建核心插件（debug DLL + Vue UI → 应用配置目录 plugins/_core/）
pnpm build:core:release  # release → src-tauri/resources/_core/（打包用）
pnpm fetch:python     # 下载捆绑 Python 运行时（python-build-standalone full → resources/python/）
pnpm build-external-ui plugins/<id>  # 构建外部插件 UI
pnpm sync:plugins     # 仓库 plugins/ → 应用插件目录（开发时同步外部插件改动）
pnpm lint && pnpm build && pnpm test   # 前端验证（lint 必须 0 警告）
cargo test --workspace                 # Rust 测试（78 + 3 新 = 81）
```

跨平台：`scripts/platform.mjs` 提供 `appDataDir()`（Windows `%APPDATA%` / macOS
`~/Library/Application Support` / Linux `~/.config`），构建/同步脚本均已使用，**不要**再写死 `%APPDATA%`。

## 5. 架构关键点（改代码前必读）

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

## 6. 坑与注意事项（按主题）

### 6.1 捆绑 Python 运行时相关的坑（本次新增）

1. **tauri 编译期校验 `bundle.resources`**：加了资源路径但目录不存在 → 整个 cargo 构建失败
   （`resource path resources\python doesn't exist`）。所以要么先下载，要么先放占位目录。
2. **python-build-standalone 命名 2026-08 起变了**：full 变体 = `-pgo-full.tar.zst`
   （zstd 压缩、pgo 优化），`.tar.gz` 只剩 `install_only`（无 pip）。旧资料里的
   `-full.tar.gz` 已不存在。且归档结构也变了：顶层 `python/` 里是 `install/`（真正运行时）+
   `PYTHON.json` 元数据——fetch 脚本已做动态定位。解压依赖系统 bsdtar 带 libzstd
   （Win11 tar 3.8.4 有；旧 Windows 的 tar 不行）——解压只发生在**构建期**，目标机无此问题。
3. **本机 GitHub 直连下载极慢**（~500KB/3min，47MB 要数小时）。**已解决**：`pnpm fetch:python
   --mirror https://ghfast.top/`（实测 ~1.4MB/s；SHA256SUMS 仍校验，镜像只加速不改内容）。
   其余镜像（gh-proxy.com / mirror.ghproxy.com / github.moeyy.xyz）当前不通。
4. **full 变体解压 180MB，需瘦身**：pdb 调试符号 ~90MB + Lib/test ~32MB + 字节码缓存。
   fetch 脚本已内置 `slimPython`（180MB → 48.7MB），删 pdb/测试/`__pycache__` 不影响运行
   （stdlib C 扩展、pip、tkinter 已验证正常）。
5. **🔴 数据对象里绝不存 tauri 类型（历史教训再现，本次真踩了）**：
   `PluginManager` 加 `app: Option<tauri::AppHandle>` 字段 → **测试二进制加载即崩
   `0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND`**（进程起不来，不是测试失败；连报错都没有）。
   这是历史 commit 8a594f1 记录过的同款坑（ProcessPlugin 存 AppHandle 触发过同崩溃）。
   **修复**：改存纯 std 缓存 `bundled_python: Option<PathBuf>`（refresh/set_enabled/install/
   reinstall_core 里拿到 AppHandle 时经 `pyruntime::bundled_python_dir` 解析路径即弃）；
   `resolve_interpreter` 改收路径参数。AppHandle 只允许活在函数参数/线程局部/tauri State 外部。
   排查经验：bin 测试二进制（toolbox-*.exe）能加载、只有 lib 测试目标崩；stash 二分法 +
   git worktree + 共享 CARGO_TARGET_DIR 可快速定位（内容不同 → 崩/不崩）。
6. **沙箱限制的迷惑表现**（若下次仍遇到"cargo test 空输出 + $LASTEXITCODE 为空"）：
   是沙箱禁止运行编译出的 exe（test 二进制）导致，不是命令问题——`cargo --version`
   前台能跑不代表 test 能跑。后台下载 0 字节卡死同理。
7. **背景任务验证模式可靠**：`cargo test --workspace *> target/cargo-test.log; Write-Host "EXIT=$LASTEXITCODE"`
   ——全量测试/构建照此写，输出落 target/（gitignored）不刷屏。

### 6.2 终端 / Git（Windows）

- **终端显示中文文件是乱码**（GBK vs UTF-8）：文件内容用 read/grep 工具看，**不要**用 `Get-Content`/`cat` 判断内容。
- **绝不使用 `Set-Content` 写含中文的源文件**（会 GBK 损坏文件）——用 write/edit 工具。
- **`Set-Content -Encoding UTF8` 会写 UTF-8 BOM**（PowerShell 5.1），serde_json 解析直接失败
  （plugins.json 变 BOM 后启用集合静默变空、插件全不启动——8/29 实测踩过）。改应用配置
  目录下的 JSON 用 write 工具（无 BOM）或 `[IO.File]::WriteAllText`。
- **中文 commit message**：`git commit -m "中文"` 在 PowerShell 会解析成 pathspec 错误 →
  用 `git commit -F <文件>`（文件放 `target/` 下，gitignored，不会误提交；提交后删掉）。
- **PowerShell 的 exit code 误报**：cargo/git 往 stderr 写内容（linker 警告、进度）时，
  PowerShell 会报 `[exit code: 1]` + NativeCommandError——这是**误报**，用 `$LASTEXITCODE` 判断真实退出码。
- 提交前 `git add -A` 会带上工作区所有未跟踪文件——注意别把临时文件/产物加进去
  （`plugins/*/ui/index.js`、`core-plugins/*/ui/index.js` 是构建产物，gitignored，勿提交）。

### 6.3 插件 UI 构建

- **`plugin-ui-build.mjs` 必须保留 `define: { "process.env.NODE_ENV": ... }`**：
  md-editor-v3（codemirror 依赖）运行时引用 `process.env`，去掉会报
  `ReferenceError: process is not defined`（冒烟测试第一屏就能抓到）。
- `build-external-ui.mjs` 会把产物复制回插件目录 `ui/`——**core-plugins 不要用
  build-external-ui 构建**（会把 index.js/style.css 复制进源码目录污染 lint；
  用 build:core，产物只在 target/plugin-ui + 部署到应用目录）。
- `core-plugins/blog/ui/style.css`、`notes/ui/style.css` 是 **git 跟踪的源文件**（不是产物），勿删。
- 外部插件 text-stats 的 `plugins/text-stats/ui/index.js` 是 gitignored 产物，构建生成。

### 6.4 依赖 / 工具链

- **archiver 8 是 ESM 重构**：无 default export，用法 `new ZipArchive({ zlib: { level: 9 } })`
  （不是 `archiver("zip")`）。见 `scripts/platform.mjs`。
- **`pnpm setup` 是 pnpm 内置命令**，会遮蔽同名 package.json script——所以初始化脚本叫 `pnpm env:setup`。
- Windows 上 `execFileSync("pnpm"/"rustc"...)` 不解析 `.cmd` 包装 → 探测用 `execSync` 走 shell
  （见 `dev-env.mjs` 的 tryCmd）。
- `vswhere.exe` 不在 PATH（固定路径 `C:\Program Files (x86)\Microsoft Visual Studio\Installer\`），
  且本机 VS Build Tools 装在**非标准路径** `D:\SDK\Microsoft Visual Studio\18\BuildTools`。
- **TypeScript 7（tsgo，Go 原生）未升级**：生态未就绪，保持 TS 5.x。
- **reqwest 锁 0.13.1**：tauri-updater 约束，勿随意升（0.13.4 已发布但没升）。
- Rust crates 走 rsproxy 镜像（`rsproxy-sparse`），vendored 在 `D:\SDK\Rust\.cargo\registry\...`。

### 6.5 运行时 / 验证

- `pnpm tauri dev` 冒烟验证方式：看终端日志——`[global-error]`/`[unhandled-rejection]`/
  `[resource-error]` 是前端错误转发；`[failed-resources] 无失败资源` 是正常（dev 模式的调试输出）。
- E2E 用 CDP（`--remote-debugging-port=9226`）驱动真实窗口：`scripts/cdp-*.mjs`；
  这些脚本**无法本地自动运行**（需已启动的 dev 实例），改选择器后需手动验证
  （cdp-notes-ui.mjs 的选择器已按 md-editor-v3 更新：`.md-editor` / `.md-editor-content textarea`）。
- 插件 UI 不经 `vue-tsc` 检查（tsconfig include 只有 `src`）——改插件 UI 后靠
  `pnpm build:core` 构建成功 + tauri dev 冒烟验证。

## 7. 重要决策记录

- 宿主与插件 UI **全 Vue 3**，React 版存档在 `react` 分支（用户决策：以后主要用 Vue 3 开发）
- 笔记编辑器 **Vditor → md-editor-v3**（Vue 3 生态；产物全打进 IIFE，gzip ~702kB，离线可用）
- **插件沙箱**：仅规划在 PLAN.md §5.2（P0：CSP 收紧 + 命令面最小化 + ShadowRealm；P1：iframe + wasm；P2：process 权限 + AppContainer），**未排期未实现**
- 数据/配置目录：业务数据在 vault 工作区；应用配置与插件在应用配置目录（跨平台解析）
- 提交策略：**本地 git 提交，推送需用户确认**；push 后 CI 自动验证
- **捆绑 Python 运行时**（2026-08-21 决策）：python-build-standalone full 变体随包分发，
  两层模型 + 三级解释器解析（**已完成**，见 §1）

## 8. 待办（除 §1 进行中的工作外）

- **🔴 未推送的本地提交（2026-08-29，4 个，+ 本轮 1 个待提交）**：`0f4fbee`（捆绑 Python 收尾）、
  `2668065`（清理无用文件/整理文档）、`885ea83`（CI 修复 resources/python 校验）、
  `f2c9e06`（docs: 记录待推送提交与网络情况）；本轮收尾提交（安装依赖按钮 + 文档）待做。
  网络情况：本机 **github.com:443 HTTPS 直连被墙**（重试多次 `Connection reset`；
  解析到 20.205.243.166 不通），但 **`ssh.github.com:443` 实测可连**（GitHub 官方
  SSH-over-443 通道）。推送选项：① 生成 SSH key 加 GitHub → 远程改
  `ssh://git@ssh.github.com:443/backunderstar/ToolBox.git`；② 开代理后
  `git config --global http.proxy http://127.0.0.1:<port>` 再 `git push origin main`。
  推送会触发 ci.yml（已修好 resources/python 占位校验）。
- **插件页"安装依赖"按钮**：✅ 已做（2026-08-29，见 §1.2/§1.4）。剩余：目标机/真实场景交互验收
  （点击按钮装依赖 → 重载生效），py-tools 已带 requirements.txt 可当验收对象
- **插件沙箱**（PLAN.md §5.2）：P0 CSP 收紧 + 命令面最小化 + ShadowRealm，未排期
- **md-editor-v3 打磨**：当前为分屏模式（原 Vditor 是即时渲染 IR），如有需要可调
  `md-editor-v3` 配置（工具栏/预览主题/代码高亮主题）
- 13 个 cdp-*.mjs 脚本的样板重复未收敛（`cdp-lib.mjs` 已抽公共，但各套件仍独立）
- 插件 UI 产物体积：notes 含 md-editor-v3 gzip ~702kB（预期内）；如优化可考虑按需拆包

## 9. 验证基线（2026-08-29 重新全绿）

`pnpm doctor` 全就绪（含捆绑 Python 运行时）· `pnpm lint` 0 警告（92 文件）·
`pnpm test` 33 · `pnpm build` ✓ · **`cargo test --workspace` 81**（78 既有 + 3 pyruntime 新测试）·
`pnpm build:core`（6 插件 + DLL 自检）· `pnpm tauri dev` 冒烟无前端错误、
**csv-tool/py-tools 均确认使用捆绑解释器** · 打包版冒烟（无 Python PATH 跑 exe：
部署捆绑运行时 + 核心插件 + 两插件用捆绑解释器）。改动后请跑对应子集。

> 注：8/28 的 0xC0000139 加载崩溃已修复（见 §6.1 坑 5）；8/29 完成 dev 冒烟 + 打包版冒烟 +
> 插件页"安装依赖"按钮；按钮的 UI 交互点击待用户真机验收。
