# ToolBox 规划文档

个人工具箱桌面应用 —— Rust 核心 + 多语言插件系统 + 主题系统。
目标功能：数据处理、清单、记录、笔记、AI 整理、博客发布。

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
- JS 插件沙箱是最难的部分：v1 采用"信任自己写的插件"模型，后期再上 Deno 沙箱。

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
Vault（用户自选的工作区目录）
├── notes/            # Markdown 笔记（可带 frontmatter 元数据）
├── data/             # 结构化数据：checklists/*.json、records/*.json
├── plugins/          # 已安装的插件（随 vault 走，可 git 管理）
├── .toolbox/         # 索引、缓存（SQLite）、应用设置
└── toolbox.json      # vault 级设置
```

- **纯文件优先** → 用 git（Rust `git2` crate）做备份和版本历史；未来博客发布直接消费 Markdown。
- **SQLite（rusqlite）** 做搜索索引和结构化查询（清单/记录/全文搜索 FTS5），索引可随时重建。
- 笔记 frontmatter（`title / tags / date / status`）是后续 AI 整理和博客发布的数据基础。

---

## 5. 功能模块路线图（里程碑）

> 每个里程碑都有可运行的成果，避免"架构过度设计"。

| 里程碑 | 内容 | 预估 |
|---|---|---|
| **M0 骨架** | Tauri 2 + TS/React 脚手架；Rust `ping` 命令打通 IPC；主题令牌 + 亮/暗切换；应用外壳布局（侧栏 + 主区 + 状态栏） | ✅ 完成 |
| **M1 笔记** | 文件树 + Vditor 即时渲染编辑器 + 新建/保存/删除 + 全文搜索 + 最近打开 + 设置页 | ✅ 完成 |
| **M2 插件系统 v1** | manifest 加载器；webview JS 插件 API；Python 进程桥（JSON-RPC）；热重载；示例插件 | ✅ 完成 |
| **M3 数据工具** | Base64 + 插件命令接入（JSON 格式化/时间戳/UUID/行尾转换已按需求移除） | ✅ 完成 |
| **M4 清单与记录** | 清单（checklist）与工作记录（record）数据模型 + UI + 与笔记双向链接 | ✅ 完成 |
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
| ✅ 已完成 | **Git 版本历史** | vault 内嵌 git（git2/libgit2）自动提交快照（编辑防抖 15s）+ 时间线 + 一键回滚；字节保真（`* -text` 防行尾改写）；未跟踪新文件回滚保留；备份排除 .git |
| ✅ 已完成 | AI 流式输出 | 对话改 SSE 流式（`ai-chunk` 事件逐段推送，打字机效果）；SSE 解析含跨块半行/CRLF/[DONE]；本地 mock 服务器端到端测试 |
| ✅ 已完成 | 审计遗留小项 | 超大文件读取保护（>8MB）、重命名前端校验（非法字符/重名）、博客站点过期提示 |
| ✅ 已完成 | 插件事件桥 | 进程插件 Notification → 纯 mpsc 事件总线（ProcessPlugin 不接触 tauri 类型，规避 0xC0000139 加载崩溃路径）→ 前端 `plugin-event` → 插件页实时事件日志；csv-tool 增加 eventTest 演示命令 |
| ✅ 已完成 | 插件全局化 | 插件从工作区 `vault/plugins` 迁到全局 `%APPDATA%/com.toolbox.desktop/plugins/`（插件是工具不属于数据）；启用状态全局统一；旧布局自动迁移（复制 + 工作区目录回收站清理）；webview 入口改由 `plugins_read_file` 限定目录读取 |

---

## 6. 建议的目录结构（monorepo）

```
ToolBox/
├── Cargo.toml              # Rust workspace
├── src-tauri/              # Tauri 主进程（Rust 核心）
│   ├── src/
│   │   ├── main.rs / lib.rs
│   │   ├── core/           # vault、存储、搜索、AI 网关、git
│   │   ├── plugins/        # 插件管理器、进程桥、manifest 解析
│   │   ├── rpc/            # JSON-RPC 协议类型（serde）
│   │   └── commands.rs     # 暴露给前端的 Tauri 命令
│   ├── capabilities/       # Tauri 权限声明
│   └── tauri.conf.json
├── src/                    # 前端（TypeScript + React）
│   ├── main.tsx / App.tsx
│   ├── themes/             # 令牌 + 主题引擎 + 内置主题
│   ├── plugin-api/         # JS 插件 API（类型定义 + 运行时）
│   ├── core/               # IPC 封装、状态管理（zustand）
│   └── components/         # 文件树、编辑器、面板、设置、命令面板
├── plugins/                # 插件目录
│   ├── example-js/
│   └── example-py/
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
| Markdown 编辑器 | CodeMirror 6 | Milkdown(ProseMirror) | 轻量、可扩展、编辑体验好 |
| 状态管理 | zustand | valtio | 简单够用 |
| Rust 核心库 | tauri / serde / tokio / rusqlite / git2 / reqwest | | 进程桥用 tokio 管理子进程 |
| 搜索 | SQLite FTS5 | tantivy | v1 够用，数据量大再换 |
| Python 桥 | stdio + JSON-RPC（serde_json） | PyO3 内嵌 | 子进程方案灵活、任意 Python 环境可用 |
| 博客 | Zola（Rust SSG） | 自定义导出 | 与 Rust 技术栈同源 |
| 测试 | cargo test + Vitest | | 核心协议层优先测试 |

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
> `"additionalBrowserArgs": "--remote-debugging-port=9226"`，`pnpm tauri dev` 后
> 用 `node scripts/cdp-e2e-clean.mjs 9226` 驱动真实 WebView2 做端到端检查（验证后移除该配置）。

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
