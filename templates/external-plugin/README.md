# ToolBox 外部插件模板（仓库外独立开发）

一个**不依赖 ToolBox 仓库**、可独立开发的外部插件项目：Python 进程（JSON-RPC）
+ Vue 3 自带前端界面。产出物是一个自包含插件目录，装进 ToolBox 即用。

## 目录结构

```
external-plugin/
├── plugin.json          # 插件清单（id/name/runtime/command/permissions/ui/nav）
├── main.py              # Python 进程骨架：JSON-RPC 协议（init/call/事件/shutdown）
├── build.mjs            # 前端构建脚本（vite lib，照抄 ToolBox 的构建逻辑）
├── package.json         # 构建依赖（vue/vite/@vitejs/plugin-vue）
├── ui/
│   ├── index.ts         # 入口：createApp 挂载 + 注册 __TB_PLUGIN_UI__["<id>"]
│   ├── App.vue          # 界面组件（宿主注入 api 桥；样式在 <style> 块）
│   ├── bridge.ts        # 桥 API 类型
│   ├── index.js         # 构建产物（npm run build 生成，勿手改）
│   └── style.css        # 构建产物（Vite 从 <style> 提取，勿手改）
└── requirements.txt     # 可选：第三方依赖（pip install --target vendor）时创建
```

## 三步跑通

```bash
# 1. 改插件名：plugin.json 的 id/name/nav，并把 ui/index.ts 里注册 key 改成你的 id
#    （id 规则：小写字母/数字开头，仅含小写字母/数字/连字符）

# 2. 装依赖 + 构建前端
npm install
npm run build          # → ui/index.js + style.css

# 3. 装进 ToolBox（二选一）
#    ① 插件页「安装目录」选本目录；或「安装 .zip」（先自己打成 zip，顶层含 plugin.json 或 <id>/plugin.json）
#    ② 把整个目录复制到应用插件目录（默认 %APPDATA%\com.toolbox.desktop\plugins\，或自定义目录）后点「刷新」
```

改 Python 代码（main.py）后在插件页点「重新加载」即可；改前端（ui/*.vue/ts）需重新 `npm run build` 再重载。

## 分发给别人

用 ToolBox 仓库的 `pnpm package-plugin <插件目录> [-o 输出.zip]`（scripts/package-plugin.mjs）
打作者侧分发包：自动排除 `vendor/ env/ .venv/ node_modules/ __pycache__/`，产物顶层 =
`<插件id>/`，对方插件页「安装 .zip」即装（Python 依赖由对方点「安装依赖」重建）。

## 关键约定

- **解释器**：command 保持 `["python", "main.py"]`，宿主三级解析（插件自带
  python.exe → 全局捆绑运行时 → 系统 PATH），**目标机无需装 Python**。
- **第三方 Python 依赖**：创建 `requirements.txt`，插件页「安装依赖」按钮用捆绑
  Python 的 pip 装到 `vendor/`；main.py 里把 vendor 插进 sys.path（模板已留注释）。
- **界面与进程通信**：界面 `api.call("hello")` → 宿主路由为 JSON-RPC 调 Python 的
  `hello` 命令；Python `notify("progress", {...})` → 界面 `api.on("progress")`。
- **命令白名单**：`init` 握手声明的 `commands` 之外一律拒绝调用。
- **样式**：只引用宿主设计令牌（tokens.css 变量：`--bg/--fg/--accent/--space-*/--radius-*`），
  随亮暗主题自适应；类名用自己插件的前缀，避免污染宿主。
- **目录不入库**：`vendor/`、`env/`、`.venv/`、`ui/index.js`、`ui/style.css` 都是
  本地生成物，分发/分享时只带源码 + plugin.json（依赖靠「安装依赖」按钮装）。

## 模板演示了什么

| 命令 / 能力 | 说明 | 涉及知识点 |
|---|---|---|
| `hello` | 普通命令（参数 + 返回值） | JSON-RPC call |
| `eventDemo` | 边处理边推送 `progress` 事件 | Python notify → `api.on("progress")` |
| `fileList` | 列 vault 内全部 .md | 核心 API `fs.listDir`（权限 `fs:read:vault`） |
| `notifyDemo` | 宿主右上角横幅通知 | 核心 API `notify`（权限 `notify`） |
| 宿主搜索卡片 | 全文搜索 | 前端 `api.host.search`（FTS + 搜索提供者） |

界面里每张卡片对应一段"可抄的代码"（调命令 / 收事件 / 读 context / host.search）。

## 参考

- **[DEVELOPER.md](DEVELOPER.md) —— 宿主接口全量参考**：可调用的方法（桥 API / 核心 API /
  事件）、plugin.json 字段全量、可复用 CSS 变量（tokens 全量）+ 宿主全局 class、推荐实现方式、
  协议速查、调试。
- 协议与 API 全量说明：ToolBox 仓库 `docs/插件开发指南.md`（§3 process 插件 / §2.3 自带前端 / §3.8 界面）
- 更多示例：ToolBox 仓库 `plugins/`（py-tools / py-jmes / csv-tool）与 `core-plugins/example`
