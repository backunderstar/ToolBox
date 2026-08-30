# Changelog

ToolBox 的所有用户可见变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 详细的开发记录（含未推送提交清单）见 [HANDOVER.md](HANDOVER.md)；里程碑规划见 [PLAN.md](PLAN.md)。

## [Unreleased]

### 结构整理（2026-09）

- 前端分层：页面级视图移入 `src/views/`（WelcomeView / PluginsView / SettingsView / FloatApp），
  `src/components/` 只留通用部件；全局样式统一归 `src/styles/`（`float.css` 移入）
- Rust 后端拆单体：`lib.rs` 957 行 → 只留入口与 `ping`；
  应用设置/托盘/窗口/浮窗/系统命令 → `core/app.rs`，日志命令 → `core/log.rs`，
  备份/配置命令归位各自模块，插件日志通道 → `plugins/commands.rs`
- `plugins/manager.rs` 的 pip 依赖安装抽为 `plugins/deps.rs`（`run_pip_install`，可独立测试）
- 新增 `.editorconfig`（跨编辑器缩进/换行/末行统一）
- 新增 CHANGELOG.md（本文件）
- 复核 `docs/技术栈与概念详解.md`:已移除功能的章节此前已标注为占位说明（学习指南保留全貌,
  避免读者困惑"为什么没有编辑器/网络层"）,无需再改
- 新增作者侧打包脚本 `scripts/package-plugin.mjs`：`pnpm package-plugin <插件目录>` 产出
  `<插件id>.zip`（排除依赖目录），与应用内「导出插件」规则一致
- 补测试：`api.ts` 全量 IPC 映射断言（10 用例）+ `plugins.ts` mock 模式注册表行为（5 用例）

### 修复

- 清理 `src-tauri/` 根目录 26 个会话残留日志文件与 `target/` 下 94 个构建日志

## [0.1.0] — 2026-08

首个可分发版本（NSIS 安装包 + 自动更新）。教学基线：宿主框架 + 一个原生示例插件
（core-example）+ 5 个 process 示例插件。

### 新增

- **插件系统（三种运行时）**：webview（JS，Blob 注入）、process（Python，JSON-RPC over
  stdio，捆绑 Python 运行时三级解析 + 「安装依赖」按钮）、native（cdylib FFI via tb-sdk）；
  统一清单 `plugin.json`（命令/事件/导航/主题/外壳动作/设置/浮窗入口声明）
- **插件自带前端**：`ui.entry` → 自包含 IIFE（Vue 3 打进产物），宿主 `PluginUiView` 注入
  api 桥（call / on / context.vault / nav / log）；样式走宿主设计令牌（tokens.css），主题自适应
- **桌面浮窗插件化**：独立透明窗口（Alt+Q / 托盘切换），内容 = 启用且声明 `float` 的插件
- **主题系统**：设计令牌 + 亮/暗基础 + 皮肤插件 + 自定义主题导入导出
- **全文搜索**：SQLite FTS5（trigram）增量索引，文件名优先 + 短词 LIKE 兜底，插件提供者聚合
- **自动备份**：vault 快照（原子提交）+ 配置/插件存档 + 两阶段恢复；后台线程自动备份
- **系统托盘**：关窗最小化到托盘（可配置：托盘常驻 / 退出应用 + 首次关闭询问）；托盘开关
- **日志管理**：`%APPDATA%/com.toolbox.desktop/logs/` 按天落盘，级别可调（debug~error），
  保留 7 天自动清理，应用内查看器（查看/过滤/清空/打开目录）；插件日志统一通道（全部形态）
- **插件管理页**：卡片列表（启用/禁用/重载/卸载/安装依赖）、DLL 安装（.zip 包或目录，
  zip-slip + zip 炸弹防护）、导出为 .zip、已卸载核心插件一键恢复、自定义插件目录（自动迁移）
- **配置迁移**：一键导出/导入配置包（localStorage + 宿主配置，不含 API Key）
- **外部插件模板**：`templates/external-plugin/`（独立 npm 工程 + DEVELOPER.md 全量参考）

### 修复

- Windows 相对路径解释器（`.venv/Scripts/python.exe`）spawn 失败（CreateProcess 不搜索
  current_dir）
- 托盘「退出」报 Error 1412（`app.exit` 强制销毁 WebView）→ 改为优雅关闭窗口
- 插件安装依赖 `PermissionError`（pip 替换 vendor 与新进程并发读）→ 先停进程再装
- 多轮警告/死代码/文档清理（详见 HANDOVER §8）

[0.1.0]: https://github.com/backunderstar/ToolBox/releases
