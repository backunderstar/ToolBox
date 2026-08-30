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
  （`[plugin] <id> 解释器: <路径> (插件自带|全局捆绑|系统 PATH 回落)`，冒烟验证用；
  8/30 改三态——此前"(捆绑/自带)"不区分插件自带与全局捆绑，排查优先级易误判）、
  py-tools 增 `requirements.txt` 示例、docs 四件套收尾（PLAN §5.1 / README / 操作手册 / 插件开发指南 §3.5）

### 1.2 验证结果（2026-08-29 实测）

1. **dev 冒烟** ✅：`pnpm tauri dev` 日志两条 `[plugin] csv-tool/py-tools 解释器:
   ...target\debug\resources\python\python.exe (全局捆绑)`（dev 下 tauri 把
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

### 1.5 增量（2026-08-30：插件页体验修复 + Python 插件界面示例）

- **修 py-jmes 安装依赖 PermissionError 并发锁**：`install_deps` 先停掉该插件进程再跑
  pip（Windows 上 pip 替换 vendor 文件与新进程 import 并发读 → `PermissionError:
  [Errno 13] ...\vendor\jmespath\__init__.py`，只出现在插件 stderr），装完前端自动
  reload 重启，生效路径不变（manager.rs）
- **修 py-venv 启动失败可读性**：`start_process` 对相对路径解释器（.venv/Scripts/python.exe）
  不存在时附"解释器文件不存在 + 需先初始化 .venv（方案 C）"提示，不再裸 os error 3
- **修错误挤占插件页**：操作错误/依赖结果横幅从 `empty-state` 大块改为紧凑 `action-bar`
  提示条（错误红底可换行、结果内可滚动），不挤压插件卡片列表（PluginsView.vue + plugins.css）
- **Python 插件界面示例（回答"process 插件如何加界面/子页"）**：py-tools 加自带前端
  （ui/index.ts + App.vue + bridge.ts + style.css，`pnpm build-external-ui` 构建产物
  gitignored），plugin.json 声明 `ui.entry` + `nav`（侧边栏「文本工具」进入；界面经
  api.call 调 Python 命令 / api.on 收 progress 事件）；机制文档见插件开发指南 §3.8
- 验证：cargo 60（55+3+2）/ lint 0 / build ✓ / test 24 / build-external-ui ✓（index.js 94KB / gzip 37KB）

### 1.6 增量（2026-08-30 下午：退出/设置页体验）

- **修退出 Error 1412**（`Failed to unregister class Chrome_WidgetWin_0. Error = 1412`）：
  托盘「退出」原用 `app.exit(0)` 强制销毁 WebView 环境 → Chromium window_impl 析构时
  注销窗口类失败（无害噪音）。改为**优雅退出**：EXITING 置位后 close main/float 窗口，
  WebView2 随窗口正常清理，run 循环自然退出（lib.rs handle_tray_event）
- **关闭主窗口行为选项**（设置页「常规」）：`app.json` 的 `closeBehavior`（"tray" 默认
  最小化到托盘 / "quit" 退出应用）。新增 `app_settings_get/set` 通用键值命令
  （%APPDATA%/com.toolbox.desktop/app.json，原子写）；on_window_event 按配置分流，
  quit 模式关主窗口时顺带关闭浮窗（否则浮窗在、应用不退出）
- **插件设置手风琴**：设置页「插件设置」段从平铺改为折叠（同时只展开一个，展开才挂载
  PluginUiView；插件多时页面不臃肿）——SettingsView.vue + settings.css
- 验证：cargo 61 / lint 0 / build ✓；1412 修复需退出应用实测确认

### 1.7 增量（2026-08-30 傍晚：收尾清理轮）

- **侧边栏折叠对齐**：TopBar 折叠按钮中心（左 padding 24+15=39px）与侧边栏图标列中心
  （折叠 24px）差 15px 不齐——topbar 左 padding 随 navCollapsed 切换（展开 17px / 折叠 9px，
  shell.css 有注释说明计算）
- **首次关闭询问 + 托盘开关**：
  - 首次点 X 弹询问框（最小化到托盘 / 退出应用 + 「不再询问」勾选）；前端
    `getCurrentWindow().onCloseRequested` 接管关闭流程，Rust 只 prevent 不 hide（hide 由前端
    执行，避免弹窗时窗口已被隐藏）；退出 = 设 closeBehavior=quit 后 close（Rust 放行）
  - 设置页「常规」新增：托盘图标开关（`tray_set_enabled` 命令，运行时 `TrayIcon::set_visible`，
    Tauri 2 无 remove/close 公开方法）+ 关闭前询问开关（app.json `closeAsk`）
  - `app.json` 键：closeBehavior / trayEnabled / closeAsk（app_settings_get/set 通用键值）
- **搜索残留清理**：`is_indexed_json` 对 data/checklists、data/todos 的旧功能特判删除
  （现在只索引 .md）；删 2 个旧功能测试；本机 e2e-vault（target/ 下测试残留）的
  notes/data/projects/site 目录与搜索索引已清（用户 vault 现为空，需自行选真实工作区）
- **警告清零**：`[workspace.lints.rust] linker_messages = "allow"`（MSVC link.exe 正常输出
  被当警告）+ 三个 member Cargo.toml 加 `[lints] workspace = true`；tb-example 宏前
  `///` → `//`（rustdoc 不为宏生成文档触发 unused_doc_comments）
- **无用代码清理**：删除 ai.css / checklists.css / projects.css / notes.css（旧功能样式），
  在用类迁移到 settings.css（settings-message / nav-settings-* / switch / theme-io-* /
  confirm-* / btn-danger）与 plugins.css（empty-state / deps-output）；App.vue 移除对应
  import；target/plugin-ui 旧插件产物清盘（保留 core-example）
- **文档完善**：操作手册（§2 目录结构 / §3.4 配置 / §3.5 外部插件示例 / §3.6 索引范围 /
  §4.2 视图表 / §4.4 调试 / §5 里程碑标注教学基线）；技术栈与概念详解（md-editor/AI/博客/
  SSG/双向链接/CDP 等旧小节删除或标注已移除、架构图/名词表更新）
- 验证：cargo 59（54+3+2，search 删 2 旧测试）/ lint 0 / build ✓ / test 24

### 1.8 增量（2026-08-30 晚：浮窗插件化 + 权限修复 + 动画 + 模板深化）

- **桌面浮窗插件化**：manifest 新增 `float: { entry: "ui/float.js" }`（FloatDecl）——插件启用且
  声明后，浮窗（Alt+Q）显示该插件界面（注册 key = 插件 id；多个声明页签切换；不声明空态）。
  浮窗窗口能力（创建/置底/快捷键/锁定）仍属宿主（lib.rs + FloatApp 外壳），FloatApp 改为动态
  加载 float 插件（独立窗口各自 pluginsList）；build-core 支持 ui/float.ts → float.js 多入口；
  core-example 新增精简浮窗（ui/float.ts + FloatPanel.vue）
- **修主窗口窗口权限**：App.vue 关闭询问流程报 `window.destroy not allowed`（default.json 缺
  窗口操作权限；浮窗 float.json 反而齐全）——补 core:window:allow-close/destroy/hide/show
- **全应用过渡动画**：视图切换（view out-in）/ 侧边栏折叠 / 模态（confirm）/ 面板（fade-slide）/
  主题切换渐变 / 插件列表 TransitionGroup（base.css 统一动画类，只动 opacity/transform）
- **模板深化**：main.py 补 call_core + fileList（fs.listDir）/notifyDemo（notify）；App.vue 四张
  演示卡片（命令/文件/搜索/事件）；DEVELOPER.md 补核心 API 端到端示例 + §6.1 宿主全局 class
  清单 + §10.1 浮窗界面
- **CSS 变量契约正式化**：tokens.css 标注「插件 UI 变量契约（公开稳定）」，宿主承诺
  只增不删不改
- **日志管理完善（P0+P1+P2 + 保留 7 天）**：core/log.rs 加级别（debug/info/warn/error，
  运行时切换持久化 app.json logLevel；低于阈值不落盘）+ 自动清理（保留 7 天，init 与
  跨天首写时 prune，days-from-civil 按日比较）；新命令 logs_path/logs_tail/logs_clear/
  log_level_set；设置页「日志」卡片（级别下拉 + 目录打开 + 应用内查看器：当天尾部 400 行、
  级别过滤、刷新、清空）；manager.rs 补插件安装/卸载/启停/恢复日志
- 验证：cargo 59（+float 声明编译）/ lint 0 / build ✓ / build:core ✓（float.js 已部署）

---

## 2. 项目一句话

个人工具箱桌面应用：**Rust 核心（Tauri 2）+ Vue 3 宿主 + 插件系统**，数据全部是
vault 工作区里的普通文件（Markdown/JSON）。
**教学基线（2026-08-29 起）**：宿主框架能力完整（工作区/宿主文件服务/全文搜索/自动
备份/插件系统/主题/托盘/浮窗/打包分发），业务功能全部插件化；核心插件仅保留一个
**教学示例 core-example**（cdylib + 自带前端，覆盖全部实现要点，教程见
docs/核心插件示例教程.md），外部 JS/Python 插件示例见 plugins/。

- 仓库：`D:\WORKSPACE\ToolBox`（远程 `github.com/backunderstar/ToolBox`）
- 语言/工具：Rust 1.97 + Node ≥20 + pnpm 10 + Vue 3.5 + Vite 8（vite-plus/rolldown）
- **分支**：`main` = Vue 3 主线；`react` = React 版冻结存档（只读，勿动）

> ⚠️ 历史功能已移除（git 历史可查，勿按旧文档恢复）：笔记/待办/清单/项目/博客/AI
> 6 个业务核心插件、记录功能、数据工具页、Git 版本历史、md-editor-v3 编辑器。

## 3. 技术栈现状（2026 大迁移后）

| 层 | 现状 |
|---|---|
| 宿主前端 `src/` | **Vue 3**（`.vue` SFC + 模块级单例 store），`vue-tsc` 类型检查，`defineAsyncComponent` 懒加载设置页/插件页 |
| 插件 UI `core-plugins/*/ui/` | **全部 Vue 3**（`index.ts` + `App.vue` + `bridge.ts`），Vite lib 构建自包含 IIFE |
| 宿主文件服务 | **core/files.rs**（vault 内文件列表/读写/增删改，2026-08 迁回本体；webview 桥与 process 核心 API 共用） |
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
8. **🔴 捆绑运行时部署竞态（8/29 打包冒烟实测，已修复）**：`deploy_bundled_python` 原为
   "先删旧目录再复制"——窗口期内部署目录只有 python.exe 没有 Lib，并发启动的 process
   插件把它当可用解释器 → Python 启动即崩（`Failed to import encodings`）。
   **修复**：改为**原子替换**（复制到同父目录 `python.tmp-<pid>` → 删旧 → rename）；
   窗口期部署目录要么完整旧版要么不存在（回落资源目录，同样完整）。
9. **`tauri build --debug --no-bundle` 不复制资源**：`target/debug/resources` 是 dev 残留
   （tauri dev 才复制）。打包冒烟前必须手动把 `src-tauri/resources/_core` + `resources/python`
   复制到 `target/debug/resources/`，且**先清空 target/debug/resources**（tauri 增量复制
   不删已消失的源目录 → 旧插件/旧资源会残留并被 ensure_core_plugins 部署回 %APPDATA%）。
   8/29 实测：旧 6 个核心插件经此残留被部署回 app `_core`（连同 core-records 复活）。
10. **🔴 `tauri-plugin-notification` 致测试二进制加载崩溃（8/29 实测）**：加该插件
    （依赖链含 `tauri-winrt-notification` WinRT 绑定）后，`cargo test` 的 toolbox_lib
    测试 exe **加载即崩 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND**（连 --list 都崩，
    与 §6.1 坑 5 同症状但不同根因——这次是依赖链，非 tauri 类型入数据对象）。
    **处理**：不用系统通知插件，`notify` 核心 API 改为**宿主 UI 横幅**（plugin-event
    `notification` 事件 → 前端 App.vue 右上角横幅，5s 自动消失），零新依赖。
    教训：新增会引入 WinRT/本地绑定的 crate 前，先 `cargo test -p toolbox --lib -- --list`
    验证测试二进制能加载（依赖树用 `cargo tree -p <crate>` 看有没有
    winrt/webview2/openssl 类原生绑定）。
11. **pip install 与插件进程并发读写 vendor = PermissionError（8/30 实测）**：
    「安装依赖」运行时若插件进程还在跑，pip 替换 vendor 文件（如 jmespath/__init__.py）
    与新进程 import 并发，Windows 文件锁会让读被拒
    （`PermissionError: [Errno 13] Permission denied: ...\vendor\jmespath\__init__.py`，
    只出现在插件 stderr）。**修复**：`install_deps` 先停插件进程再 pip，装完由前端
    reload 重启（manager.rs）。另：相对路径解释器（方案 C .venv）缺失时 spawn 失败
    os error 3 不可读——start_process 现附"解释器文件不存在 + 需初始化"提示。
12. **🔴 插件目录出现"不可访问"子目录（8/30 实测，本次 PermissionError 的真根因）**：
    应用启动时 py-jmes/py-env 同时报 `PermissionError: [Errno 13] ...\vendor\jmespath\
    __init__.py` / `...\env\regex\__init__.py`——**不是并发锁，是这两个目录本体异常**
    （读写、icacls、Get-Acl、takeown 全部被拒，连 admin 都打不开，但父目录正常）。
    排查要点：① `cipher /s <目录>` 的 `U` = **未加密**（Unencrypted），不要误判成 EFS；
    目录/文件 attrib 无 `E` 属性即未加密；② 无进程占用、无 Defender 拦截（实时保护
    关闭）时仍打不开 → 目录 ACL/状态损坏。**处置**：同卷**重命名父目录可绕过**
    （如 `vendor → vendor.bad`，rename 不遍历内容）→ 用捆绑 python 重建依赖目录
    （`pip install --target vendor -r requirements.txt` / `--target env <pkg>`）→ 把
    坏目录移到插件根外（%TEMP%）待管理员清理。根因未明（怀疑历史提权写入/文件系统
    异常），若再出现先照此处置。另：**sync:plugins 曾因单个坏目录全量崩溃**——已加固：
    ① 保留本地依赖目录（vendor/env/.venv/node_modules，全量重建会误删「安装依赖」
    装的依赖）；② 单插件失败仅告警继续、不崩全量；③ ui 目录只同步构建产物
    （index.js/style.css），源码留仓库。
13. **自定义插件目录（8/30，本机已迁到 `D:\ToolBoxData\plugins`）**：
    - 改法：插件页「插件目录 → 更改…」（自动迁移 + 旧目录进回收站），或
      `%APPDATA%/com.toolbox.desktop/plugins.json` 顶层加 `"plugins_dir": "D:\\..."`
      （手改**不迁移**，需自行搬目录；JSON 用 write 工具写避免 BOM）。
    - **scripts 必须跟随**：`platform.mjs` 的 `pluginsDir()` 已改为读 plugins.json 的
      `plugins_dir` 键（与 Rust `manager::global_plugins_dir` 同规则）——sync:plugins /
      build:core 才不致同步到 %APPDATA% 旧位置。**改 plugins_dir 前先确认此联动**。
    - **别放 Program Files**（只读，装依赖/卸载失败）；迁移用 robocopy /MOVE 跨卷
      复制+删除，先退出应用。
    - **sync 的依赖保留 stash 必须与插件目录同卷**（放 dstRoot 下）：放 os.tmpdir()
      会因跨卷 rename EXDEV 失败 → 依赖随全量重建被删（8/30 实测踩过）。
14. **🔴 相对路径解释器 + current_dir 的 CreateProcess 坑（8/30 实测）**：方案 C 插件
    command 用相对路径（`.venv/Scripts/python.exe`）时，`std::process::Command::new(相对路径)
    .current_dir(插件目录)` 在 Windows 上**仍报 os error 3**（"系统找不到指定的路径"）——
    CreateProcess 搜索可执行文件用的是**宿主进程自己的 cwd**，不搜索 lpCurrentDirectory
    （与 Node/exec 不同，它们会把 cwd 拼进路径）。**修复**：start_process 在 spawn 前把
    相对解释器解析为插件目录下绝对路径（`resolve_relative_program`，有单测）；文件不存在
    保持原样（走"解释器文件不存在"提示）。经验：Windows 上凡"相对路径 exe + current_dir"
    都要先绝对化，别假设 std 会拼 cwd。

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
- 外部插件的 `plugins/*/ui/index.js`、`style.css` 是 gitignored 产物，构建生成（勿手改/勿提交）。
- **ui 样式必须写在 .vue 的 `<style>` 块（或 JS `import` 的 css）**，Vite 才会提取为
  style.css 产物并随构建/同步部署；**手写独立 ui/style.css 若不被 import，构建产物里
  没有它 → 插件界面裸奔**（8/30 实测：core-example 曾手写 style.css，部署目录始终缺
  style.css、界面无布局。修复：样式并入 App.vue `<style>` 块、删除独立文件；
  py-tools 同法，两个示例界面已按宿主 tokens 统一升级）。

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
- **`_core` 残留目录坑（8/29 实测）**：`ensure_core_plugins` 是**逐个覆盖部署、不清空
  `_core`**（为保留用户手动安装的本地 DLL 插件）——已删除功能的旧部署目录不会自动清掉，
  会在 refresh 时被扫描并尝试加载旧 DLL。8/29 发现 `core-records`（8/16 旧部署）残留：
  仓库早已删除 records 功能，但目录还在 `%APPDATA%\...\plugins\_core\`。清理 = 直接删目录
  （无随包资源，无需记 removed_core）。日后移除核心插件功能时记得检查目标机 `_core` 残留。

## 7. 重要决策记录

- 宿主与插件 UI **全 Vue 3**，React 版存档在 `react` 分支（用户决策：以后主要用 Vue 3 开发）
- 笔记编辑器 **Vditor → md-editor-v3**（Vue 3 生态；产物全打进 IIFE，gzip ~702kB，离线可用）
- **插件沙箱**：仅规划在 PLAN.md §5.2（P0：CSP 收紧 + 命令面最小化 + ShadowRealm；P1：iframe + wasm；P2：process 权限 + AppContainer），**未排期未实现**
- 数据/配置目录：业务数据在 vault 工作区；应用配置与插件在应用配置目录（跨平台解析）
- 提交策略：**本地 git 提交，推送需用户确认**；push 后 CI 自动验证
- **捆绑 Python 运行时**（2026-08-21 决策）：python-build-standalone full 变体随包分发，
  两层模型 + 三级解释器解析（**已完成**，见 §1）

## 8. 待办（除 §1 进行中的工作外）

- **🔴 未推送的本地提交（2026-08-29 教学基线收敛起累积，勿推送）**：完整清单见
  `git log origin/main..HEAD`；最新为 8/30 的插件页体验修复 + sync 脚本加固（§6.1 坑 12）。
  网络情况：本机 **github.com:443 HTTPS 直连被墙**（重试多次 `Connection reset`；
  解析到 20.205.243.166 不通），但 **`ssh.github.com:443` 实测可连**（GitHub 官方
  SSH-over-443 通道）。推送选项：① 生成 SSH key 加 GitHub → 远程改
  `ssh://git@ssh.github.com:443/backunderstar/ToolBox.git`；② 开代理后
  `git config --global http.proxy http://127.0.0.1:<port>` 再 `git push origin main`。
  推送会触发 ci.yml（已修好 resources/python 占位校验）。
- **插件页"安装依赖"按钮**：✅ 已做（2026-08-29，见 §1.2/§1.4）；8/30 补「先停插件进程
  再 pip」修复并发 PermissionError（§6.1 坑 11）。剩余：目标机/真实场景交互验收
  （点击按钮装依赖 → 重载生效），py-jmes 已带 requirements.txt 可当验收对象
- **插件沙箱**（PLAN.md §5.2）：P0 CSP 收紧 + 命令面最小化 + ShadowRealm，未排期
- **按教学基线写新核心插件**：`docs/核心插件示例教程.md` 的"照猫画虎"清单已给步骤；
  新插件 = core-plugins/<id>/（crate + ui）+ build-core.mjs PLUGINS 一项 + Cargo members
- 插件 UI 产物体积：外部插件自带前端含 Vue runtime gzip ~36kB（预期内）

## 9. 验证基线（2026-08-29 教学基线收敛后全绿）

`pnpm lint` 0 警告（53 文件）· `pnpm test` 24（2 文件）· `pnpm build` ✓ ·
**`cargo test --workspace` 60**（宿主 55 + pyruntime 3 + core-example 2，含 native DLL 集成测试与插件导出 zip 往返测试）·
`pnpm build:core`（core-example 1 插件 + DLL 自检，自动清理旧随包插件）·
`pnpm tauri dev` 冒烟：5 个 process 插件全部使用捆绑解释器、core-example 部署无异常 ·
打包版冒烟（无 Python PATH 跑 exe：部署捆绑运行时 + 核心插件 + 插件用捆绑解释器）。
改动后请跑对应子集。

> 注：8/28 的 0xC0000139 加载崩溃已修复（见 §6.1 坑 5）；8/29 完成 dev 冒烟 + 打包版冒烟 +
> 插件页"安装依赖"按钮 + **教学基线收敛**（6 业务核心插件移除 → core-example 教学示例）。
> 曾踩：旧构建器产物残留 `process.env` 导致插件 UI 报 `process is not defined`
> （已用 plugin-ui-build.mjs 重建；该产物 gitignored，勿手改）。

## 10. Python 插件示例（2026-08-29 新增，仓库 `plugins/`）

| 插件 | 形式 | 演示点 | 依赖安装 |
|---|---|---|---|
| `py-jmes` | 方案 A vendored | jmespath 查询 + 事件推送（progress） | 按钮/vendor |
| `py-files` | — | 核心 API 权限（fs.readText/writeText/listDir + log）+ UTF-8 中文 | 无 |
| `py-env` | 方案 B env/ | 二进制 wheel（regex cp314）ABI 匹配 | `pip install --target env` |
| `py-venv` | 方案 C .venv/ | command 用 `.venv/Scripts/python.exe` | venv 创建 + pip |
| `csv-tool` | 最小骨架 | 协议最小实现 | 无 |
| `py-tools` | 方案 A vendored | 事件 + 搜索提供者 + 核心 API + **自带前端界面**（§3.8：侧边栏「文本工具」进入，api.call 调命令 / api.on 收事件） | 按钮/vendor |

要点：源码（plugin.json/main.py/requirements.txt）入库；**依赖目录不入库**
（`.gitignore` 已加 `plugins/*/vendor|env|.venv`），靠按钮/命令安装——
例外：**py-tools/vendor 是 8/16 就入库的老文件**（当时无按钮只能提交依赖），保持现状，
如想统一为"不入库"可另行 git rm -r --cached。
「安装依赖」按钮只装 `vendor/`（有 requirements.txt 才显示），故 **py-env/py-venv
不声明 requirements.txt**（依赖目标分别是 env/ 与 .venv，声明了按钮会装错位置）；
py-jmes 是按钮的正确验收对象。
已实测（8/29）：4 个新插件协议冒烟全过（init/call/事件/中文），dev 冒烟 5 个 process
插件全部使用捆绑解释器（`%APPDATA%\...\python\python.exe` 部署目录优先解析生效）。
方案 D（插件自带整个 python.exe，+15~25MB）无法入库，做法见插件开发指南 §3.5 与示例清单。

## 11. 教学基线（2026-08-29，用户决策）

- **6 个业务核心插件（笔记/待办/清单/项目/博客/AI）全部移除**（core-plugins/ 只剩 example），
  宿主引用同步清理：api.ts（fs* 改走宿主命令、删 ai*/todos* 封装）、vault.ts（精简为
  工作区/搜索/上下文快照，不再持有文件树）、navigation（ViewId 泛化，删 openNote/openChecklist）、
  App.vue（固定视图分支收敛为 overview/plugins/settings + 插件动态路由）、FloatApp
  （页签 = core-example）、SettingsView（删 AI 段）、AISettings/blogfm 删除、14 个 cdp-*.mjs 删除
- **宿主文件服务迁回本体**：`src-tauri/src/core/files.rs`（files_list/read/write/create/
  delete/rename，全部 S1c vault 校验）——文件操作是插件系统与宿主共用的系统级能力，
  不应挂在可装卸插件上（webview 桥 fs.readText/writeText 与 process 核心 API 同源）
- **教学示例 core-example**：覆盖全部核心插件实现要点（见 docs/核心插件示例教程.md）
- 验证基线见 §9；未推送提交清单见 §8

## 13. 三项完善（2026-08-29，用户选定）

1. **process 核心 API 扩展**（plugins/process.rs + 指南 §3.3）：
   - 新增权限门控核心 API：`notify`（宿主 UI 横幅）、`open`（默认应用打开）、
     `clipboard.read/write`（剪贴板）、`http.request`（reqwest blocking，超时 +
     4MB 上限）、`shell.exec`（Command，超时 + 输出尾部；**强能力**）
   - permissions 声明才可用（KNOWN_PERMISSIONS 更新）；py-files 演示全部
   - `notify` 经 plugin-event `notification` 事件 → 前端横幅（App.vue）
   - ⚠️ 教训：tauri-plugin-notification 致测试二进制 0xC0000139（见 §6.1 坑 10）
2. **插件导出分享**（插件页「导出」按钮）：
   - `plugins_export` 命令（manager.rs export_zip，zip crate ZipWriter，顶层
     `<id>/` 目录与 install zip-slip 兼容）+ api.ts + PluginCard/PluginsView UI
   - 单测 export_zip_roundtrip（打包→解压往返验证）
3. **webview 最小示例 hello-tb**（plugins/hello-tb/）：命令注册式 sayHello，
   插件开发指南 §1 五分钟跑通的仓库实体

验证：cargo 60（+export 单测）/ lint 0 / build ✓ / test 24 / dev 冒烟（py-files
10 命令 + hello-tb + 无崩溃）；核心 API 协议链路经模拟宿主脚本端到端验证
（target/mock-host.py）。

## 12. 宿主可扩展性增强（2026-08-29）

新增三个"与宿主外壳集成"的**声明式扩展点**（manifest 声明即接入，插件无需改宿主；
机制见插件开发指南 §7 宿主外壳扩展点）：

1. **顶栏动作**（`actions[].topbar`）：顶栏渲染插件图标按钮
2. **托盘菜单**（`actions[].tray`）：托盘渲染「插件名：动作」项，插件启停自动重建
   （宿主监听前端 `plugins-changed` 事件 → `rebuild_tray`；预热后首建）
3. **设置页插件段**（`settings.entry`）：设置页「插件设置」段挂载插件自定义面板
   （注册 key 约定 `settings:<pluginId>`；PluginUiView 支持 entry/regKey）。
   ⚠️ `PluginInfo.settings` 透传 **entry 字符串**（与 ui 字段同款）——曾误透传整个
   SettingsDecl 对象，前端按 string 用导致 `plugins_read_file` 报 `rel: invalid type:
   map`（8/30 实测修复，manager.rs list()）。

统一交互契约：外壳动作点击 → 宿主发 `plugin-event` 事件 `action`（插件 UI
`api.on("action")` 订阅）+ 非 webview 插件调约定命令 `plugin.action {action, source}`
（source = topbar|tray|settings）。实现：前端 `triggerPluginAction`（plugins.ts）、
Rust `plugin_shell_action`（lib.rs，托盘点击）。

core-example 全量演示：顶栏按钮（greet）+ 托盘两项（greet/open）+ 设置面板
（ui/settings.ts + SettingsPanel.vue）+ `plugin.action` 命令 + 主界面/面板事件日志。
build-core.mjs 支持多入口构建（ui/index.ts → index.js、ui/settings.ts → settings.js）。

新增扩展点路径（后续同类需求照此）：manifest.rs 字段 → manager.rs PluginInfo 透出 →
前端组件遍历渲染（TopBar/SettingsView 等）+ Rust 侧消费（托盘）；交互统一走
plugin-event `action` + `plugin.action` 命令，插件端无需感知外壳来源。
