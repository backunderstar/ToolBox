# ToolBox 规划文档

个人工具箱桌面应用 —— Rust 核心 + 多语言插件系统 + 主题系统。
目标功能：清单、待办、笔记、项目文件管理、AI 整理、博客发布。

---

## 0. 核心决策（已确认）

| 维度 | 选择 | 理由 |
|---|---|---|
| 形态 | 桌面应用（Windows） | 数据本地、离线可用、适合上班 |
| 核心语言 | Rust | 性能、文件/进程/AI 网关能力、体积小 |
| 界面 | WebView（Tauri 2） | 主题系统、插件 UI、开发速度远超原生 GUI |
| 插件语言 | JS/TS + Python 起步，协议化后可加任意语言 | 覆盖数据处理 + 界面集成场景 |
| 数据 | 纯文件优先（Markdown/JSON）+ SQLite 索引 | 可移植、可 git、可直接喂给博客引擎 |

**一句话架构**：Rust 负责"重活"（文件、搜索、AI、插件进程管理），WebView 负责"好看"（界面、主题），两者之间用一层统一的插件协议把 JS 插件和 Python 插件串起来。

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────┐
│  WebView UI  (TypeScript + React)                        │
│  ┌──────────┐ ┌───────────┐ ┌─────────────────────────┐  │
│  │ 主题引擎  │ │ 组件库     │ │ JS 插件宿主（插件 API）  │  │
│  └──────────┘ └───────────┘ └─────────────────────────┘  │
└──────────────────────────┬───────────────────────────────┘
                           │ IPC（Tauri commands / events）
┌──────────────────────────┴───────────────────────────────┐
│  Rust 核心（Tauri 2）                                     │
│  · Vault 文件管理（文件树、读写、监视）                    │
│  · 搜索索引（SQLite FTS5 → 后期可换 tantivy）             │
│  · AI 网关（多提供商、流式响应）                          │
│  · Git 集成（备份 / 版本）                                │
│  · 插件管理器 ── 进程桥（JSON-RPC over stdio）            │
│     ├── Python 插件（子进程）                             │
│     └── 未来：Lua / Go / Ruby（同一协议）                 │
└──────────────────────────┬───────────────────────────────┘
                           │ 文件系统 / 网络
            Markdown · JSON · SQLite · AI API · Git
```

### 为什么是 Tauri 2 而不是别的

- **vs Electron**：核心是 Rust（符合你的要求），包体 ~10MB 对 ~150MB，内存占用低；Windows 上基于 WebView2（Chromium 内核），渲染能力一致。
- **vs 纯原生 GUI（egui / iced / slint）**：你要"简约好看的界面 + 主题系统 + 插件 UI"，Web 技术栈（CSS 变量、组件库）的开发效率和主题灵活度是原生 GUI 比不了的；Rust 侧的 egui 生态做主题和插件面板都很吃力。
- **vs 纯 Web 应用**：桌面形态保住了本地数据和离线使用，符合上班场景。

### 风险提示

- WebView2：Win10 较老版本需单独装运行时；办公内网机器需提前确认。
- Python 插件依赖机器有 Python；后期可用 `uv` 管理的嵌入式 Python 打包进去。
- 插件沙箱（重点：webview 插件命令面全开 + CSP 侧信道、native 插件 FFI 崩溃拖垮宿主）：v1 采用"信任自己写的插件"模型；长期方案见 §5.2 插件沙箱（ShadowRealm / iframe sandbox / WASM 三路并行；嵌入式 JS 运行时方案已排除——成本高且与 ShadowRealm 收益重叠）。

---

## 2. 插件系统设计（本项目的灵魂）

### 2.1 统一抽象：所有插件是"一个清单 + 一组命令 + 一组事件"

```
plugin.json（每个插件一个）
{
  "id": "csv-tools",
  "name": "CSV 工具集",
  "version": "0.1.0",
  "runtime": "process",              // process = 子进程 | webview = 界面内 JS
  "command": ["python3", "main.py"], // runtime=process 时生效
  "entry": "main.ts",                // runtime=webview 时生效
  "permissions": ["fs:read:vault", "network:no", "ai:no"],
  "config": { }
}
```

### 2.2 两类运行时

| 类型 | 语言 | 运行位置 | 能力 |
|---|---|---|---|
| `webview` 插件 | JS/TS | WebView 内 | 可以注册 UI（命令面板条目、侧边面板、状态栏）、读写 vault、订阅事件 |
| `process` 插件 | Python 等任意语言 | 独立子进程 | 通过协议调用核心 API：读写文件、HTTP、AI、事件 |

### 2.3 通信协议：JSON-RPC 2.0 over stdio（NDJSON）

子进程插件与核心之间，标准输入/输出各一行一个 JSON 对象：

```
核心 → 插件   call     {id, method:"cmd.csv.parse", params:{...}}
插件 → 核心   result  {id, result:{...}} / {id, error:{...}}
插件 → 核心   invoke  {method:"fs.readText", params:{path}}   // 调用核心 API
核心 → 插件   event   {event:"note.changed", data:{...}}
```

生命周期：`start → init（注册命令/订阅）→ ready →（call / event）* → stop`。
健壮性：调用超时、进程崩溃自动重启（带次数上限）、协议版本协商。

> 关键点：协议只依赖"能读写 stdin/stdout"，所以**未来任何语言**（Lua、Go、Ruby、甚至 PowerShell）只要实现这个协议就能成为插件——这就是你"以后支持更多脚本语言"的落点。

### 2.4 对插件暴露的核心 API（v1 面）

```
fs:       readText / writeText / readDir / exists   （限定 vault 或白名单路径）
http:     get / post（受权限控制）
ai:       chat(stream) / embed                      （调用用户配置好的模型）
events:   subscribe / publish
settings: 插件自己的配置读写
ui:       registerCommand / registerPanel / setStatusBar   （仅 webview 插件）
```

### 2.5 示例插件（用于验证系统，也是首批实用工具）

- `example-py`：CSV → JSON、批量重命名、文本统计（Python，走进程桥）
- `example-js`：命令面板示例、状态栏时钟、选区转换工具（JS，webview）
- 内置数据工具（M3）：JSON 格式化、时间戳转换、Base64、UUID 生成、行尾转换等——大多可以做成很薄的插件

---

## 3. 主题系统设计

### 3.1 设计令牌（Design Tokens）→ CSS 变量

所有视觉属性收敛为一组 CSS 变量，UI 组件只引用变量，不写死颜色：

```
:root / [data-theme="dark"] {
  --color-bg / --color-bg-soft / --color-fg / --color-fg-muted
  --color-accent / --color-border / --color-danger
  --font-sans / --font-mono / --text-xs..xl / --line-height
  --space-1..8 / --radius-sm..lg / --shadow-1..3 / --ease / --dur
}
```

### 3.2 主题包 = 清单 + 覆盖样式

```
themes/my-theme/
├── theme.json   { id, name, base: "light"|"dark", version }
└── theme.css    /* 只覆盖令牌即可，不必重写组件 */
```

### 3.3 主题引擎（前端）

加载 → 校验（只允许覆盖令牌）→ 切换（`data-theme` 属性）→ 持久化。
内置 2~3 个主题起步（简约亮色、暗色、暖色），后续做主题编辑器（M5）。
图标与字体也作为主题的可选资源。

---

## 4. 数据与存储设计

**理念：一切落地为普通文件，不锁死数据。**

```
Vault（用户自选的工作区目录，纯数据）
├── notes/            # Markdown 笔记（可带 frontmatter 元数据）
├── data/             # 结构化数据：checklists/*.json、todos/todos.json
├── projects/         # 项目文件（+ archive/）
├── site/             # 博客发布生成物（可重建）
└── .toolbox/         # 备份（backups/）、搜索索引（SQLite）；插件与配置在应用目录
```

- **纯文件优先**：数据即文件（Markdown/JSON），任意编辑器可读；备份 = 快照复制（保留最近 N 份 + 配置/插件存档），恢复 = 覆盖合并（回滚手段）。
- **SQLite（rusqlite）** 做搜索索引（FTS5），索引可随时重建。
- 笔记 frontmatter（`title / tags / date / status`）是后续 AI 整理和博客发布的数据基础。
- **核心功能插件化**：宿主只留框架（窗口/工作区/插件宿主/设置/主题），笔记/记录/项目等以**核心插件（cdylib，宿主进程内 FFI）** 形态存在，可启用/禁用/热重载。

---

## 5. 功能模块路线图（里程碑）

> 每个里程碑都有可运行的成果，避免"架构过度设计"。

| 里程碑 | 内容 | 预估 |
|---|---|---|
| **M0 骨架** | Tauri 2 + TS/React 脚手架；Rust `ping` 命令打通 IPC；主题令牌 + 亮/暗切换；应用外壳布局（侧栏 + 主区 + 状态栏） | ✅ 完成 |
| **M1 笔记** | 文件树 + Vditor 即时渲染编辑器 + 新建/保存/删除 + 全文搜索 + 最近打开 + 设置页 | ✅ 完成 |
| **M2 插件系统 v1** | manifest 加载器；webview JS 插件 API；Python 进程桥（JSON-RPC）；热重载；示例插件 | ✅ 完成 |
| **M3 数据工具** | 工具页已按用户决定移除（JSON 格式化/时间戳/UUID/Base64 等） | ✅ 已移除 |
| **M4 清单** | 清单（checklist）数据模型 + UI + 与笔记双向链接（记录功能已按用户决定移除） | ✅ 完成 |
| **M5 主题系统完整** | 主题包格式 + 切换器 + 主题编辑器；3 内置主题（亮/暗/暖） | ✅ 完成 |
| **M6 AI 集成** | 提供商配置（OpenAI 兼容 API）；对话/整理面板；选区摘要；笔记问答（轻量 RAG） | ✅ 完成 |
| **M7 博客发布** | frontmatter → 导出管线；内置 SSG（Zola 兼容源）一键生成/预览/发布 | ✅ 完成 |
| **M8 项目文件管理** | 项目目录 + 归档；文件浏览器；点击用默认应用打开 | ✅ 完成 |
| 持续 | 插件仓库/市场、设置面板、系统托盘、跨平台（macOS/Linux） | 长期 |

**依赖顺序**：M0 → M1 → M2（插件系统尽早落地，之后所有新功能都尽量以插件形式演进）→ M3/M4 并行 → M5 → M6 → M7。

### 5.1 后续待办（Backlog，按用户确认的顺序排期）

| 优先级 | 事项 | 说明 |
|---|---|---|
| ✅ 已完成 | **桌面半透明浮窗清单** | 独立窗口（透明/无边框/置顶/位置记忆）+ `data/todos.json` 纯文件真源 + 事件双窗同步；顶栏按钮显隐 |
| ✅ 已完成 | API Key 安全加固 | AI 配置的 API Key 存系统凭据管理器（keyring），ai.json 不再存明文；旧配置自动迁移 |
| ✅ 已完成 | 打包版 CSP 配置 | 生产构建启用严格 Content-Security-Policy（响应头注入，含 Vditor/插件兼容：style 放行 inline、插件走 blob: 执行）；开发模式不受限 |
| ✅ 已完成 | 自动备份 | vault 定时备份到 `.toolbox/backups/`（保留最近 N 份，可配置；设置页管理） |
| ✅ 已完成 | 系统托盘 | 关窗最小化到托盘常驻；托盘菜单（显示主窗口/显示隐藏浮窗/退出）+ 单击切换 |
| ✅ 已完成 | 插件 stdin 写入超时 | 插件不读 stdin 挂死时写管道缓冲满会无限阻塞——改为写线程 + 超时回收，超时即终止进程；含挂死单测 |
| ✅ 已完成 | 全文搜索性能 | SQLite FTS5（trigram 分词器）索引，增量同步 + 文件名优先 + 短词 LIKE 兜底；实测 3000 篇热查询 ~200ms；rusqlite 需 bundled-full |
| ✅ 已完成 | 单实例 | 官方 tauri-plugin-single-instance 插件（双开退出 + 恢复托盘窗口；事件桥曾误伤其首轮接入，隔离排查后澄清） |
| ✅ 已完成 | **Git 版本历史**（已按用户决定移除） | vault 内嵌 git（git2/libgit2）自动提交 + 时间线 + 回滚；用户认为备份已足够，功能整体删除（git2 依赖、自动提交线程、历史视图）；旧 vault 里的 `.git` 残留可手动清理，备份承担数据回滚职责 |
| ✅ 已完成 | AI 流式输出 | 对话改 SSE 流式（`ai-chunk` 事件逐段推送，打字机效果）；SSE 解析含跨块半行/CRLF/[DONE]；本地 mock 服务器端到端测试 |
| ✅ 已完成 | 审计遗留小项 | 超大文件读取保护（>8MB）、重命名前端校验（非法字符/重名）、博客站点过期提示 |
| ✅ 已完成 | 插件事件桥 | 进程插件 Notification → 纯 mpsc 事件总线（ProcessPlugin 不接触 tauri 类型，规避 0xC0000139 加载崩溃路径）→ 前端 `plugin-event` → 插件页实时事件日志；csv-tool 增加 eventTest 演示命令 |
| ✅ 已完成 | 插件全局化 | 插件从工作区 `vault/plugins` 迁到全局 `%APPDATA%/com.toolbox.desktop/plugins/`（插件是工具不属于数据）；启用状态全局统一；旧布局自动迁移（复制 + 工作区目录回收站清理）；webview 入口改由 `plugins_read_file` 限定目录读取 |
| ✅ 已完成 | **核心插件 cdylib 化（阶段 0）** | Cargo workspace（宿主 + tb-sdk + core-plugins/*）；tb-sdk 定义 C ABI 契约（tb_abi_version/tb_create/tb_call/tb_free_string/tb_destroy + TbHostApi 宿主回灌含 ctx）；libloading 加载器 + `_core` 目录 + 统一 plugin_call 路由；records（记录）下沉为原生插件（CRUD/事件/搜索提供者，真实 DLL 集成测试）；备份改造（恢复到备份点 + %APPDATA% 配置/插件存档）；搜索提供者机制（manifest searchProvider，search_all 聚合命中）；删除版本历史 |
| ✅ 已完成 | **核心插件 cdylib 化（阶段 1）** | 笔记/待办/清单/项目 全部迁移为原生核心插件（5 个 cdylib 插件：records/notes/todos/checklists/projects）；宿主 core/ 只余 ai/blog/backup/search/vault；核心插件**默认启用**（显式禁用记入 disabled 集合，旧格式兼容）；侧边栏/视图注册表完全动态化（入口由插件 nav 声明提供，按 group 归组，禁用即消失 + 守卫占位）；api.ts fs*/todos*/projects* 透明转发 plugin_call；E2E 9/9 |
| ✅ 已完成 | **核心插件 cdylib 化（阶段 2）** | 博客/AI/搜索/备份 全部迁移为原生核心插件（共 **9 个 cdylib**：records/notes/todos/checklists/projects/blog/ai/search/backup）；宿主 core/ 只余 vault + path（**核心就留框架**）；博客预览服务器移入插件（tiny_http 进程内单例）；AI 插件内自建 tokio runtime + keyring 凭据 + SSE 流式（ai-chunk 经事件桥）；搜索插件（SQLite FTS5）+ search_all 聚合 providers；备份插件（自动备份线程移入插件）；manifest `system` 锁定（backup/search 不可禁用）；侧边栏彻底插件化（AI/博客入口由插件 nav 提供）；E2E 8/8 |
| ✅ 已完成 | **打包分发（阶段 3）** | `build:core:release` 构建 release DLL → `src-tauri/resources/_core/` 打进安装包（bundle.resources）；宿主启动 `ensure_core_plugins` 从资源部署到 %APPDATA%（清空后整体复制，与应用版本一致，仅打包构建执行）；build.rs 预创建资源目录；打包版 E2E 8/8（debug bundle + release DLL 加载/部署全链路） |
| ✅ 已完成 | **插件自带前端（阶段 4 pilot）** | 插件目录 = DLL + 前端页面，加载时一起加载：manifest `ui.entry` 声明；插件前端（`core-plugins/<id>/ui/`，React+TSX）由 Vite lib 模式构建为自包含 IIFE（React 打进产物，NODE_ENV 显式 define）放进插件目录 `ui/`；宿主 `PluginUiView` 经 `plugins_read_file` 读入口 → Blob `<script>` 注入（CSP blob: 允许）→ 插件注册 `__TB_PLUGIN_UI__[id]` → 注入 api 桥（call → plugin_call / on → plugin-event / context.vault）挂载到 React 树（非 iframe）；`plugins_read_file` 支持 `_core/<id>`；pilot = core-blog（列表/生成/预览/状态切换全链路 E2E 4/4）；未声明 ui 的插件仍用宿主内置组件，其余插件前端迁移待用户确认逐批进行 |
| ✅ 已完成 | **插件前端迁移样板（core-projects）** | 数据层（core/projects.tsx）并入 `core-plugins/projects/ui/index.tsx`：api 桥替代 useProjects/useVault、本地 state 管导航、内联图标 + 复用宿主 ConfirmDialog/.projects-* CSS；build-core.mjs 声明 ui；App 路由优先 PluginUiView（宿主组件保留回退）；E2E 4/4 |
| ✅ 已完成 | **插件自带前端全部迁移（阶段 5）** | 统一 api 桥升级：`buildBridgeApi` 增 `nav`（go/openNote/openChecklist 跨视图跳转）+ context 扩展（activePath/activeContent 宿主快照）+ `on` 跨插件订阅；core-notes 写操作发 notes-changed（宿主 vault 监听刷新文件树）；跨视图"打开笔记"经 `tb:open-note` 同 document 事件 + 挂载期标记；笔记插件打开文件经 `tb:vault-active` 回写宿主 vault（AI 预设读取当前笔记）。**迁移 6/6**：记录/笔记/清单/AI/待办浮窗（+ 已完成的博客/项目）。笔记插件含 Vditor（cdn 复用宿主 /vditor）；浮窗改为宿主外壳 + core-todos 插件 UI（拖拽/锁定/列表全在插件内）。dev E2E 8/8（NOTES/AI/RECORDS/CHECKLIST/TODOS/BLOG/PROJECTS/RUNTIME_REGRESS） |
| ✅ 已完成 | **整体打包验收（阶段 6）** | `build:core:release`（release DLL + ui → resources/_core）→ `pnpm tauri build --debug` 打包版 exe + NSIS 安装包；打包版（release 资源部署到 %APPDATA%）E2E 8/8 全过；NSIS 静默安装到临时目录 → 运行已安装 exe：启动日志干净（插件部署/浮窗创建/无失败资源），%APPDATA% 插件含 ui 清单与文件；cargo 55 测试 + pnpm build 全绿 |
| ✅ 已完成 | **搜索/备份迁回宿主本体（阶段 7，用户决策）** | 搜索与备份是系统级横切能力而非可装卸业务插件，从 core-plugins 迁回宿主框架：`src-tauri/src/core/search.rs`（SQLite FTS5 + 6 测试）+ `core/backup.rs`（快照/配置/插件存档/恢复 + 60s 后台线程 + 3 测试）；宿主命令 `search_all` 直调并仍聚合启用插件的 `search.provide`（记录）；新增 `backup_now/config_get/config_set/list/restore` 宿主命令，api.ts 备份段改 invoke；统一桥增 `host.search`（笔记/AI 插件界面复用宿主搜索）；`system` 锁定语义随迁回而消除（字段保留）；插件数 9 → 7（Cargo members、build-core.mjs、mock 同步）；dev E2E 8/8 + 宿主命令冒烟（插件列表 7 个/搜索含提供者聚合/备份建列恢复） |
| ✅ 已完成 | **移除数据工具页（用户决策）** | 删除 ToolsView + src/tools/registry.tsx（Base64 工具）与侧边栏"数据工具"入口/路由/欢迎页卡片；插件命令试玩保留在插件页（CommandTry 共用组件不删）；清理死亡图标（IconSliders/IconBraces/IconClock/IconHash/IconText/IconEnter/IconCopy）与专属 CSS；共享样式（.segmented/.tool-option/.tool-check/.tool-result）保留；pnpm build + dev 验证（侧边栏/欢迎页/设置页导航配置均无残留，runtime-regress 通过） |
| ✅ 已完成 | **移除记录功能 + 插件页铺满修复（用户决策）** | 删除 core-records 插件（crate + ui + 搜索提供者）、宿主 RecordsView/core/records.tsx/RecordsProvider、记录路由与导航（openRecord/openRecordId）、反链中的记录来源、WelcomeView 卡片；笔记插件 UI 反链/搜索来源同步简化；宿主全链路测试改用 tb_notes.dll（native_plugin_load_and_call）；插件数 7 → 6。**铺满修复**：.plugin-ui-view/.plugin-ui-container 缺 CSS 导致插件子页面未占满主区——补 flex 布局（容器占满 + 子视图 height:100%），实测笔记/AI 视图几何与主区完全一致。验证：cargo 51 测试、pnpm build、dev E2E 7/7（notes/ai/checklists/todos/blog/projects/regress） |
| ✅ 已完成 | **导航栏全配置化（用户决策）** | navPrefs 升级 v2：`{ groups, order, meta }`——分组（内置 work/system + 用户自定义 + 插件动态组）、每组的项顺序（**插件项位置也可配置**）、项元数据覆盖（标签/图标/隐藏）。`normalizeNav(cfg, defs)` 归一化兜底：内置组常驻、自定义组新建/改名/删除（组内项回默认组）、settings 强制可见、失效项（插件禁用）保留配置（重启用回到用户位置）、新项自动补默认组、存储自愈。Sidebar 按 config/defs 渲染（分组折叠记忆 + meta 覆盖）；NavSettings 升级全配置编辑器（新建/重命名/删除分组、**HTML5 拖拽跨组移动**、组内上下移、隐藏开关、标签/图标编辑表单、恢复默认）；旧版 v1 配置自动迁移。验证：pnpm build、dev E2E 8/8（新增 NAV_FULL：默认渲染/折叠/新建组/拖拽跨组/改标签/隐藏/恢复默认）+ 既有 7 套件全过 |
| ✅ 已完成 | **全代码审查 + 整改批次 1（功能修复）** | 多代理并行审查（前端/Rust/插件/构建/安全/契约）产出分级整改方案（用户批准顺序推进）。批次 1：AI 流式对话修复（`ai.chatStream` 在宿主 tokio worker 线程上 `rt().block_on` 嵌套另一 runtime 必 panic → 改为插件实例持有 runtime 并 `spawn` 独立任务，流结束/失败改由新增 `ai-done` 事件通知）；反链"打开清单"修复（宿主回退视图收不到 viewParams → 改 `tb:open-checklist` 事件广播 + 挂载期标记，与 openNote 同机制）；前端三 bug（navPrefs 损坏存储白屏、NavSettings 运算符优先级致误移分组、api.on/vault 监听取消竞态）。验证：cargo 51 测试、pnpm build、E2E 3/3（checklists/nav/ai） |
| ✅ 已完成 | **整改批次 2（数据安全）** | 备份快照原子提交（先复制到隐藏 `.backup-*.tmp` 再 rename，崩溃只留被忽略的残留，杜绝"半截备份被恢复覆盖线上数据"）；恢复两阶段（先复制到暂存目录校验源完整再覆盖，失败可手工补救）；`backup_config_set` 范围钳制 + 后台线程 clamp/saturating_sub 防整数溢出 panic（debug）；prune 改按时间戳排序（修复跨位数边界删错备份）。验证：cargo 54 测试（新增 3 个边界测试） |
| ✅ 已完成 | **整改批次 0（轻量安全）** | S1a `plugins_read_file` id 白名单 + root 规范化复核（堵 `../` 穿越任意文件读取）；S1b native 运行时强制 `_core` 目录（第三方插件声明 native 直接拒绝，堵任意 DLL 加载进宿主进程）；S1c vault 参数服务端校验（所有带 vault 命令绑定已配置工作区，防作用域指向任意目录）；S3 清单 get/save/delete 统一 id 校验（堵 `../` 越出清单目录读写）；S4 插件卸载崩溃（ai runtime 从 static 移入实例 drop 时 shutdown、blog 预览线程可停止 + 实例 Drop 时 join，FreeLibrary 后无残留线程执行已卸载代码）。验证：cargo 58 测试、E2E 4/4（notes/checklists/ai/blog） |
| ✅ 已完成 | **死代码清理（用户决策）** | 6 个核心插件全部自带前端后，宿主回退视图成为死代码：删除 NotesView/ChecklistView/ProjectsView/AIChatView/BlogView + Editor/FileTree/Backlinks + 宿主数据层 checklists.tsx/projects.tsx（App 路由简化为"插件启用→PluginUiView / 禁用→占位"，未知视图不再静默落笔记视图）；删除 api.ts 28 个死封装（博客/项目/待办/对话/openUrl）与 nav 声明失效 view 字段；删除 public 调试页、core-records 构建残留、notes.listDir 死命令、BlogGenerateResult.indexUrl 幽灵字段。全程净删 3196 行。验证：cargo 58 测试、pnpm build、E2E 8/8 全过 |

### 5.2 长期规划（未排期，架构演进候选）

#### 插件沙箱（整体优先级 P1，未排期）

**背景/威胁面**（2026 全代码审查确认）：
- `native`（cdylib FFI，进程内）：插件崩溃（panic/段错误）即宿主崩溃；DLL 内可做任何事
- `webview`（JS 全权）：`api.call` 命令面全开（可调 notes.write/delete 等任意宿主命令，Rust 侧只校验 vault 匹配）；CSP `img-src` 放开 `http: https:` → 存在把 vault 内容编码进图片 URL 侧信道外传的风险
- `process`（Python 子进程）：OS 进程隔离 + `permissions` 门控，基础最好，缺网络/文件白名单细化

**路线（按性价比排序）**：

| 阶段 | 内容 | 说明 |
|---|---|---|
| P0 | CSP 收紧 | `img-src` 移除 `http:/https:`（Vditor 粘贴图片是 `data:` URI 不受影响；外链图按需加白名单）——堵侧信道 |
| P0 | webview 插件命令面最小化 | `buildBridgeApi` 按 manifest 权限只注入白名单命令（替代当前命令面全开） |
| P0 | 无 UI 插件迁 ShadowRealm | TC39 stage 3，Chromium 121+ 支持（WebView2 跟随更新）；干净 JS 全局（无 DOM/IO），宿主注入白名单 api 桥；text-stats 等作示范 |
| P1 | UI 型 webview 插件迁 iframe sandbox | `sandbox="allow-scripts"` + postMessage 桥，天然无同源能力 |
| P1 | 新增 `runtime: "wasm"` | tb-sdk 定义 wit 接口（WASI 0.2 / Component Model 已事实标准）+ 宿主 wasmtime 加载器；**第三方 native 插件**从"FFI 全权"改"WASM 能力受限"（内存安全 + capability 授权，宿主内嵌接近 FFI 延迟）；现有 6 个核心插件是自己写的（信任），可保持 native 不动 |
| P2 | process 插件权限细化 | 复用 manifest `permissions` 字段，加网络/文件白名单 |
| P2 | 宿主进程 AppContainer 降权 | Windows AppContainer / Job Object / 受限 token，纵深防御 |

**选型结论**：WASM 是 **native 插件**沙箱化的正确工具（内存安全 + 宿主内嵌 + capability 模型），但不是整个插件系统的通用沙箱——JS 插件用 ShadowRealm/iframe，Python 插件保持子进程。WASI 0.3 concurrency 落地前，SSE 流式 / AI 长阻塞类插件不宜迁 WASM（无线程/异步系统访问）。

---

## 6. 建议的目录结构（monorepo）

```
ToolBox/
├── Cargo.toml              # Rust workspace（宿主 + tb-sdk + core-plugins/*）
├── tb-sdk/                 # 核心插件 SDK：C ABI 契约 + tb_plugin! 样板宏 + 路径安全
├── core-plugins/           # 核心插件（cdylib，随应用分发；共 6 个，全部自带前端）
│   ├── notes/              # 笔记（notes/ 文件操作 + Vditor 编辑器 + 反链）
│   ├── todos/              # 待办（浮窗数据层 + todos-changed）
│   ├── checklists/         # 清单（data/checklists CRUD）
│   ├── projects/           # 项目（projects/ 目录 + 归档 + 打开）
│   ├── blog/               # 博客（frontmatter + 站点生成 + 预览服务器）
│   └── ai/                 # AI（OpenAI 兼容 + SSE 流式 + keyring）
├── src-tauri/              # Tauri 主进程（宿主框架 + 插件宿主）
│   ├── src/
│   │   ├── main.rs / lib.rs
│   │   ├── core/           # vault、path、search（SQLite FTS5）、backup（自动备份）
│   │   ├── plugins/        # 插件管理器、native 加载器、进程桥、事件桥、manifest
│   │   └── rpc/            # JSON-RPC 协议类型（serde）
│   ├── capabilities/       # Tauri 权限声明
│   └── tauri.conf.json
├── src/                    # 前端（TypeScript + React）
│   ├── main.tsx / App.tsx
│   ├── themes/             # 令牌 + 主题引擎 + 内置主题
│   ├── core/               # IPC 封装、插件运行时、vault 状态、导航配置
│   └── components/         # 侧边栏、插件 UI 容器、设置、导航配置编辑器
├── plugins/                # 外部插件示例（仓库内，部署到 %APPDATA%）
├── docs/                   # 架构、插件开发指南、主题开发指南
├── PLAN.md
└── package.json
```

---

## 7. 技术选型清单

| 层 | 选型 | 备选 | 说明 |
|---|---|---|---|
| 桌面框架 | Tauri 2 | Electron | Rust 核心 + 小体积 |
| 前端 | React + TypeScript + Vite | Vue / Svelte / 原生 | 生态最大，插件 UI 好做 |
| Markdown 编辑器 | Vditor | CodeMirror 6 | 即时渲染 + 所见即所得，前端静态资源随应用分发（实际选型；CodeMirror 曾为候选） |
| 状态管理 | React 内置（state/context + ref 最新值模式） | zustand | 视图已插件化，宿主状态面小，未引入额外库 |
| Rust 核心库 | tauri / serde / serde_json / rusqlite / reqwest / libloading / tiny_http / keyring | | 插件宿主 + FTS 搜索；核心插件经 C ABI 加载 |
| 搜索 | SQLite FTS5（宿主 core/search.rs） | tantivy | v1 够用，数据量大再换 |
| Python 桥 | stdio + JSON-RPC（serde_json） | PyO3 内嵌 | 子进程方案灵活、任意 Python 环境可用 |
| 博客 | 自研 SSG（frontmatter → HTML）+ tiny_http 预览 | Zola | 与 Rust 技术栈同源，可控 |
| 测试 | cargo test + CDP E2E 脚本（cdp-*.mjs 驱动真实 WebView2） | Vitest | 核心协议层/宿主逻辑 cargo test；界面层真实运行验证 |

---

## 8. 从哪里开始：今天的行动清单

1. **验证工具链**（本机已装 rustc / cargo / node / pnpm / python / git，在普通终端确认版本）。
2. **脚手架**：在 `D:\WORKSPACE\ToolBox` 下执行 `pnpm create tauri-app`（选 TypeScript + React 模板）。
3. **跑通**：`pnpm install && pnpm tauri dev`，看到应用窗口。
4. **git init** 并提交初始版本。
5. 按 **M0 清单** 推进：
   - [x] 外壳布局：侧栏 / 主区 / 状态栏
   - [x] 主题令牌 + 亮暗切换按钮
   - [x] 一个 Rust 命令（如 `fs::ping` 返回版本号）从前端调通
   - [x] 设置页骨架

> 进度：M0 ✓（骨架/主题/ping）→ M1 ✓（笔记模块+设置页）→ M2 ✓（插件系统 v1，53da90d）→ M3 ✓（数据工具，e6d864f）→ M4 ✓（清单与记录，4ba3ecc）→ M5 ✓（主题系统，b5af457）→ M6 ✓（AI 集成：提供商配置/对话/选区摘要/RAG 问答，f42b071）→ M7 ✓（博客发布：frontmatter/站点生成/内置预览，f42b071）。**里程碑全部完成。**
>
> 真实运行验证方法：临时在 `src-tauri/tauri.conf.json` 的 windows[0] 加
> `"additionalBrowserArgs": "--remote-debugging-port=9226"`（并在 `lib.rs` 浮窗
> builder 同样加一行，浮窗独立 WebView 无参数不注册 CDP target），`pnpm tauri dev`
> 后用 `node scripts/cdp-*.mjs 9226` 驱动真实 WebView2 做端到端检查（验证后两处都移除）。

> 注：当前 AI 会话的沙箱禁止执行外部程序（运行 exe 被拒绝），所以构建/运行命令需要你在自己终端执行；文件读写、代码编写、脚手架文件生成我都可以直接完成。

---

## 9. 参考项目（学它们的思路）

- **Obsidian** — 插件 API、命令面板、主题生态的范式（我们的插件/主题设计参考它）
- **Zola** — Rust 写的静态博客生成器（博客里程碑直接复用）
- **Lapce** — Rust 写的高性能编辑器，插件化思路
- **Deno / deno_core** — JS 沙箱运行时（后期 JS 插件沙箱化的方向）
- **tauri-plugin-* 生态** — 官方插件体系，可借鉴权限模型

---

## 10. 需要尽早拍板的决策点

1. **vault 概念**：确认"用户选一个文件夹作为工作区"的数据模型（强烈建议，Obsidian 验证过的路子）。
2. **JS 插件信任模型**：v1 允许插件直接跑在 WebView（自己用没问题）；若要发布给别人用，再上 Deno 沙箱。
3. **AI 提供商**：先做 OpenAI 兼容接口（DeepSeek / OpenAI / 通义等都能接），避免绑定单一厂商。
4. **编辑器取向**：纯 Markdown 源码编辑（CodeMirror 6，推荐起步）还是所见即所得（Milkdown）——建议先源码编辑，WYSIWYG 后置。
