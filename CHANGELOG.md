# Changelog

ToolBox 的所有用户可见变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 详细的开发记录见 [HANDOVER.md](HANDOVER.md)；里程碑规划见 [PLAN.md](PLAN.md)。

## [0.3.0] — 2026-09-02

探针卡分层插件核心重写（Python + 130MB vendor → Rust native cdylib），算法提质提速，
前端与插件系统多项 Bug 修复与 UI 统一。

### 变更

- **探针卡分层插件（probe-rat-layer）计算核心 Rust 化**：原 process Python（vendor 130MB）
  改写为 **native cdylib 核心插件**（`tb_probe_rat_layer.dll`，随应用分发），零 vendor、
  性能接近进程内直接调用；命令/事件/前端契约**完全不变**，宿主沿用 `libloading + C ABI`
  加载。jobs/cache/settings 落在应用配置目录 `probe-rat-layer/`，重启恢复上次任务
  （见 `core-plugins/probe-rat-layer/` 与 `docs/改造方案-探针卡分层Rust化.md`）。
- **分层算法提速 + 提质（方案 B）**：
  - `_resolve_conflicts` 改**边驱动**（硬冲突图边 → 同层坏单元集，就近挪到无冲突允许层），
    复杂度由 O(线²) 降到 O(边数+坏单元×邻接度)；
  - `_enforce_capacity` 改**增量更新**（移动只在受影响格点算占用、增量改栅格，去掉整栅格
    clone + 全量 max 扫描）；
  - 初始铺层改 **MFPS（最难优先）排序 + `preferred_dir` 方向感知**贪婪；模拟退火
    `hard_conflict_in` 邻接表化（O(deg)）。
  - 实测（`hv` 预设，1800 网，release）：**73.6s → 1.74s**，已分配 1781→1798、
    需人工 19→2、硬冲突/软冲突与旧版持平。
- **文件浏览器限定工作区**：`layer.listDir` 从工作区根开始、钳制在工作区内、不再列盘符；
  修复"浏览失败：目录不存在"（空路径把 `Some("")` 当真实目录）。
- **HV 信号网分类修复**：`classify_net`/`_vdigit` 由"V 后任意位置出现数字"改为"**V 紧邻
  数字**"，避免把 `..._HV_1` 这类信号误判为电源/平面网。

### 修复

- **结果页完成显示旧数据**：`cmd_run` 的 `set_active` 不写 `active.job_id`，导致
  `layer.status` 返回过期 jobId，前端据此 `layer.result` 读到上一次结果。改为启动任务时
  同步 `active.job_id`，前端仅在前端未知 job 时才接收 `status.jobId`。
- **耗时 undefined**：存储 / 事件中的 summary 统一用 `summary_ext`（含 `elapsed_sec`）。
- 框架 UI 统一：`window.prompt` 改为 `PromptDialog`；确认框 / 按钮 / 空态 / 通知等统一走
  设计令牌（`tokens.css`）。

### 新增

- 核心插件（cdylib）分层算法的**真实数据回归测试**（`cargo test -- --ignored`，应用 `hv`
  预设），输出指标便于核对；`docs/探针卡分层-可布线零过孔改进方案.md`（规划稿）。

## [0.2.0] — 2026-09-02

数据根目录模型 + 首启引导 + 随包插件分发 + 文件浏览/插件文件动作。

### 新增

- **数据根目录模型**（重定义工作区）：选择一个文件夹作为所有数据的根（如
  `D:\ToolBoxData`），根下 `Project/`、`Plugin/`、`Config/` 大项（应用只管理
  `Project/`）；**工作区 = `数据根/Project/<名称>`**，日常选定工作区后文件处理
  （搜索/备份/文件/插件）都作用于当前工作区
- **首启引导页**：未配置数据根时全屏引导（选数据根目录 + 选主题），完成进主界面
- **每个工作区自动维护隐藏目录 `.toolbox`**：该工作区的标记 + 配置/信息存放处
  （宿主写搜索索引/备份/`workspace.json` 元数据，插件可读写，文件视图隐藏）
- **新建/切换工作区**：顶栏工作区下拉（含「新建工作区…」）+ 设置页切换/新建
- **插件随安装包分发**（`pnpm bundle:plugins`）：probe-rat-layer（含 vendor 离线依赖 +
  production UI）打进安装包，首启部署到全局插件目录；**所有插件默认关闭**（core-example
  也默认禁用，要用哪个手动启用）
- **宿主文件浏览视图**：浏览/新建文件夹/新建文件/重命名/移动/复制（`files_move` /
  `files_copy`）/删除（回收站）/打开/搜索，多选批量操作，排序（名称/时间/大小），
  右键菜单
- **插件文件上下文动作**：manifest `actions` 支持 `file: true`——文件视图右键/批量菜单
  的「插件处理」二级菜单列出插件动作，把选中文件列表传给插件（`plugin.action`
  source="file"），插件决定文件组织/处理逻辑；探针卡插件示例：初始化项目结构 +
  按批次归档
- **插件管理解耦**：插件列表/启停/安装/卸载/依赖不再依赖工作区（全局操作）

### 修复

- 设置页「检查更新」多处字面 `false`（模板 `&&` 表达式渲染 bug）→ 单一 computed
- 插件页空状态撑出滚动条（`height:100%` + padding 溢出）→ 自适应
- CI 两处根因：搜索目录签名只依赖目录 mtime（CI 上延迟导致新增文件搜不到）→ 加入
  条目名列表；签名 secret 粘贴带结尾换行（base64 解码失败）→ 工作流自动去尾换行

## [0.1.0] — 2026-09-01

首个可分发版本（NSIS 安装包 + 自动更新）。教学基线：宿主框架 + 一个原生示例插件
（core-example）+ 探针卡分层插件（probe-rat-layer，真实算法工具）。

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
- **探针卡分层插件（probe-rat-layer）**：真实算法工具插件化（vendored probe_layer），
  异步任务模型（后台线程分层 + 轮询进度 + 取消）、按需渲染 PNG（matplotlib 懒加载 +
  磁盘缓存）、进程重启后结果恢复、输入/参数/预设持久化，见 `plugins/probe-rat-layer/README.md`
- **设置页卡片铺满**：去掉设置页 `max-width: 760px` 限宽，与插件页面一致

### 修复

- Windows 相对路径解释器（`.venv/Scripts/python.exe`）spawn 失败（CreateProcess 不搜索
  current_dir）
- 托盘「退出」报 Error 1412（`app.exit` 强制销毁 WebView）→ 改为优雅关闭窗口
- 插件安装依赖 `PermissionError`（pip 替换 vendor 与新进程并发读）→ 先停进程再装
- 多轮警告/死代码/文档清理（详见 HANDOVER §8）

[0.1.0]: https://github.com/backunderstar/ToolBox/releases
