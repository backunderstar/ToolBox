# Changelog

ToolBox 的所有用户可见变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 详细的开发记录见 [HANDOVER.md](HANDOVER.md)；里程碑规划见 [PLAN.md](PLAN.md)。

## [0.4.7] — 2026-09-28

**探针卡分层：同 net 整网归层（3-pin 的 2 段线尽量同层）+ DC 分层质量标定 + pin 表换新基线**；
同步修订"核心插件只剩 core-example"的过时文档，并**更换更新签名密钥**。

### 新增

- **同 net 整网归层**（`same_net_consolidate`，**默认开**）：同一 net 的多段飞线
  （3-pin = 2 段、≥4-pin = MST 多段）在分层/SA 之后**整网挪到同一层**，只有该层放不下才允许跨层。
  实现 `post_process::consolidate_same_net_layers`：判据含**硬冲突检查（O(deg) 邻接）+ 层均衡上限**
  （`same_net_merge_slack`，默认 1.15），因此**只减跨层、不新增硬冲突**。
  实测（1280 net / 1362 飞线，多段网 82 个）：
  - 4 层：跨层 net **65 → 0**（过孔归零）、层线数失衡 **0.0385 → 0.0089**、同层交叉 1132 → 1327；
  - 6 层：跨层 net **68 → 0**、层线数失衡 **0.1057 → 0.0088**、同层交叉 414 → 535。
  插件设置页新增「同 net 整网归层」开关与「整网归层均衡上限」；DC/AC/POWER 预设均纳入（`PRESET_REV` 2 → 3）。
  回归确认：DC 守护数据集 A（1800 网）**已分配 1798 / 需人工 2 不变**（无多段网 → 零影响）；
  数据集 B（640 网）同层交叉 198 → 300、层线数失衡 0.1108 → **0.0055**、跨层 net → **0**。
  说明：既有的 `same_net_same_layer` / `same_net_via_penalty` 只作用于 packing 初始分组，
  SA 精修器不感知同 net，故此前三种设置结果逐位相同、跨层依旧——本次在后处理阶段补齐。

### 实测更新（pin 表换新 `1165P_3D_new.xlsx`）

- **AC 预设在新表上复测**（11 层，4660 网，release，两次运行一致）：需人工 **0**、全量 4660 网落层、
  洪泛走通 **100%**、同层交叉 **2492**（原表 2482）、占用峰值 1.00（原 0.89）——算法参数未改，
  结论不变；对照"旧几何 + DC 式算参（阈值 3.0）"= 4517 已分配 / 143 需人工 / 2962 交叉。
- **`PWR_VDD1_SENSE.lst` 现在可以分层了**：换表前该名单 640 个 net 在 pin 表里**每个只有 1 个 pin**，
  被"单 pin 剔除"挡掉 → 0 net；新表下 **640 个 net 全部 2 pin，640 飞线全部落层、0 需人工、
  同层交叉 0、洪泛 100%**。
- **DC 回归守护在新表上仍然全绿**：数据集 A（1800 网）已分配 1798 / 需人工 2 与硬断言一致；
  数据集 B（`DC_VFSBLN_IN.lst`，640 网）已分配 722 / 0 需人工 / 洪泛 100%。
- 真实数据测试路径同步新表（`real_data_ac_sweep` / `real_data_dc_preset_regression` 数据集 B），
  新增四个 `#[ignore]` 真实数据测试：`real_data_pwr_sense_layering`（单名单分层）、
  `real_data_pwr_dc_layering`（DC 预设组合 + 层数扫描）、`real_data_dc_quality_sweep`
  （分层质量参数扫描）、`real_data_same_net_layer_sweep`（整网归层 A/B）。
- **DC 预设分层质量调参结论**（1280 net / 1362 飞线，允许牺牲时间）：
  - **"0 需人工 + 每层更均匀"**：硬冲突阈值 3.0 → **4.8** 即可（需人工 12 → **0**，
    层线数失衡 0.0089 → **0.0029**）；
  - **同层交叉显著下降只能加层**：4 层 1327 → **6 层 640**（同时峰值 1.33 → 1.11、洪泛 100%）；
  - 4 层峰值 1.33 是圆心拥塞的**几何下限**（放宽硬冲突阈值或层容量都不变）；
  - SA 侧边际收益：重启 10 + 初温 20 把 4 层交叉 1327 → 1276；阈值 4.8 后再堆 SA/均衡反而回升
    （1347 → 1389），**不建议叠加**。

### 修复

- **筛选文件"命中 0"时给出可定位的提示**（`io/xlsx.rs`）：此前只报
  "保留 0 个 net（剔特殊网/单 pin 后 N 个）"，看不出是**名字对不上**还是**表里有但只有 1 个 pin**。
  现在分两条：① 整份名单无交集时给出显式告警（提示核对名单与 pin 表是否同源）；
  ② 常规统计追加"名单 N 条中 M 条未匹配到表内 net"。
  典型场景：`LIST\PWR_VDD1_SENSE.lst`（640 个 `*_DPS_S1a`）在 `1165P_3D.xlsx` 里
  **每个 net 都只有 1 个 pin**，被"单 pin 剔除"规则挡掉 → 0 net 分层；
  同目录 `PWR_VDD1_IN.lst` / `PWR_VDD2_*.lst` 名字同源，分别命中 640 / 1165 个 net。
  详见 [core-plugins/probe-rat-layer/README.md](core-plugins/probe-rat-layer/README.md) 的
  "筛选文件里的 net 没被识别/没被分层"一节。

### 文档

- **修订"核心插件只剩 core-example"的过时表述**（探针卡分层 2026-09 转为 native 核心插件后未同步）：
  - [README.md](README.md)：教学基线段、核心插件小节、目录说明改为"core-example（教学示例）+
    probe-rat-layer（真实算法）"；
  - [docs/操作手册.md](docs/操作手册.md)：§3.1 业务命令说明（改为"当前唯一业务命令面 = `layer.*`"）、
    §3.7 核心插件 cdylib、§4.2 浮窗内容（改为"声明 `float` 的已启用插件"）、§5 里程碑表、
    §7 已知边界、§8 学习路线（原引用已删除的 `core-plugins/notes` 数据流与 crate）；
  - [docs/技术栈与概念详解.md](docs/技术栈与概念详解.md) §3.6、[docs/核心插件示例教程.md](docs/核心插件示例教程.md)
    （补真实工具级示例入口 + 完整 manifest 字段）、[docs/插件开发指南.md](docs/插件开发指南.md)
    §0.2 `_core` 目录示例（`core-notes` → `core-example`/`probe-rat-layer`）；
  - [scripts/build-core.mjs](scripts/build-core.mjs) 顶部注释同步（仅注释，无行为变化）。

### 安全 / 发布

- **更换更新签名密钥**（旧私钥口令遗失）：生成新 minisign 密钥对，新公钥写入
  `tauri.conf.json → plugins.updater.pubkey`；新口令另存（不入库），旧密钥与旧配置备份在
  `target/updater-key-backup-*/`。
  ⚠ 公钥变更后，**已安装且使用旧公钥的版本无法通过自动更新**升级到新密钥签名的包，
  需手动安装一次新版；GitHub Secrets 已同步为新私钥/口令。

## [0.4.6] — 未发布（内容合并进 0.4.7）

> 本版本号的改动未单独发布，全部内容已并入 [0.4.7]。


**探针卡分层 AC 预设按真实数据重新标定**（11 层 / 0.1 / 0.1 / 阈值 4.8 + 热 SA + 均衡护栏 2.5）：
用项目里现成的 **4 个 TDQ 筛选文件**（`AC_TDQ0/1/8/9`，并集 4660 网）作测试数据确定算法参数，
目标"分层效果好、各扇区均匀、各层均匀"。**DC、Plane(POWER)、全量预设逐字未改。**

### 新增

- **同 net 整网归层**（`same_net_consolidate`，**默认开**）：同一 net 的多段飞线
  （3-pin = 2 段、≥4-pin = MST 多段）在分层/SA 之后**整网挪到同一层**，只有该层放不下才允许跨层。
  实现 `post_process::consolidate_same_net_layers`：判据含**硬冲突检查（O(deg) 邻接）+ 层均衡上限**
  （`same_net_merge_slack`，默认 1.15），因此**只减跨层、不新增硬冲突**。
  实测（1280 net / 1362 飞线，多段网 82 个）：
  - 4 层：跨层 net **65 → 0**（过孔归零）、层线数失衡 **0.0385 → 0.0089**、同层交叉 1132 → 1327；
  - 6 层：跨层 net **68 → 0**、层线数失衡 **0.1057 → 0.0088**、同层交叉 414 → 535。
  插件设置页新增「同 net 整网归层」开关与「整网归层均衡上限」；DC/AC/POWER 预设均纳入（`PRESET_REV` 2 → 3）。
  回归确认：DC 守护数据集 A（1800 网）**已分配 1798 / 需人工 2 不变**（无多段网 → 零影响）；
  数据集 B（640 网）同层交叉 198 → 300、层线数失衡 0.1108 → **0.0055**、跨层 net → **0**。

### 实测更新（pin 表换新 `1165P_3D_new.xlsx`）

- **AC 预设在新表上复测**（11 层，4660 网，release，两次运行一致）：需人工 **0**、全量 4660 网落层、
  洪泛走通 **100%**、同层交叉 **2492**（原表 2482）、占用峰值 1.00（原 0.89）——算法参数未改，
  结论不变；对照"旧几何 + DC 式算参（阈值 3.0）"= 4517 已分配 / 143 需人工 / 2962 交叉。
- **`PWR_VDD1_SENSE.lst` 现在可以分层了**：换表前该名单 640 个 net 在 pin 表里**每个只有 1 个 pin**，
  被"单 pin 剔除"挡掉 → 0 net；新表下 **640 个 net 全部 2 pin，640 飞线全部落层、0 需人工、
  同层交叉 0、洪泛 100%**。
- **DC 回归守护在新表上仍然全绿**：数据集 A（1800 网）已分配 1798 / 需人工 2 与硬断言一致；
  数据集 B（`DC_VFSBLN_IN.lst`，640 网）已分配 722 / 0 需人工 / 洪泛 100%。
- 真实数据测试路径同步新表（`real_data_ac_sweep` / `real_data_dc_preset_regression` 数据集 B），
  新增四个 `#[ignore]` 真实数据测试：`real_data_pwr_sense_layering`（单名单分层）、
  `real_data_pwr_dc_layering`（DC 预设组合 + 层数扫描）、`real_data_dc_quality_sweep`
  （分层质量参数扫描）、`real_data_same_net_layer_sweep`（整网归层 A/B）。
- **DC 预设分层质量调参结论**（1280 net / 1362 飞线，允许牺牲时间）：
  - **"0 需人工 + 每层更均匀"**：硬冲突阈值 3.0 → **4.8** 即可（需人工 12 → **0**，
    层线数失衡 0.0089 → **0.0029**）；
  - **同层交叉显著下降只能加层**：4 层 1327 → **6 层 640**（同时峰值 1.33 → 1.11、洪泛 100%）；
  - 4 层峰值 1.33 是圆心拥塞的**几何下限**（放宽硬冲突阈值或层容量都不变）；
  - SA 侧边际收益：重启 10 + 初温 20 把 4 层交叉 1327 → 1276；阈值 4.8 后再堆 SA/均衡反而回升
    （1347 → 1389），**不建议叠加**。
- **DC 预设下的名单组合实测**（新表，4 层 / 0.2 / 0.2）：`DC_VFSBLN_IN.lst` **命中 640/640
  （2 pin × 115 + 3 pin × 525，722 飞线）**；与 `PWR_VDD1_SENSE.lst`（640 个 2-pin net）合并为
  **1280 net / 1362 飞线**后，4 层**装不下**（已分配 1350 / 需人工 12 / 同层交叉 1132 / 占用峰值 **1.33 超容**）；
  层数扫描：5 层峰值仍 1.11（超容、9 需人工），**6 层 = 0 需人工 / 交叉 414 / 峰值 0.89 / 洪泛 100%**，
  8 层交叉降至 150。峰值 1.33 是圆心拥塞的**几何下限**（放宽硬冲突阈值或放开层容量都仍为 1.33）。

### 变更

- **AC 预设补全并标定**（`ui/App.vue::applyPreset("ac")`）：此前 AC 分支只设层数/线宽/线距/网格/阈值，
  其余算法项**沿用表单当时的值**（可能是"自定义"残留或引擎默认），真实数据上会大量进人工清单。
  现按"质量优先 + 实测标定"写全：
  - 几何：**11 层 / 线宽 0.1 / 线距 0.1**（原 12 层 / 0.1 / 0.2）、`cell 2.0`、**硬冲突阈值 3.0 → 4.8**；
  - 算法：`packing + sa`、冲突消解 15 轮、层长均衡 6 轮、贪心交叉 6 轮、SA 重启 3、
    **热 SA（初温 20 / 冷却 0.9998 / 交换率 0.9）**、**均衡护栏 `sa_balance_slack` 2.5**、
    扇区 45°、层容量 1.0、容量利用率 0.6、过孔预留 0.1、**拥塞均衡开（40 轮）**。
  - 实测（11 层，4660 网，release，同配置两次一致）：**需人工 210 → 0、同层交叉 2723 → 2482、
    层线数失衡 0.260 → 0.094、扇区失衡 0.052 → 0.035、层占用峰值 0.89、洪泛走通 100%、约 23s**。
- **DC / Plane 零影响**：`hv`（DC）、`power`（POWER）、`full` 分支与 Rust 侧代码**未改动**；
  新增 `real_data_dc_preset_regression` 忽略测试锁定 DC 基线（1800 网：已分配 1798 / 需人工 2）。
- **UI 文案同步**：预设下拉、层数/线距推荐、硬冲突阈值提示按新标定更新。
- **修复"改了预设却不生效"**：设置里持久化的是"预设 + 全部参数"，载入时原本"先套预设、再用存档值
  逐项覆盖"——于是**代码里更新过的预设内值会被旧存档盖回**。实测现象：升级后选着「AC」预设，
  跑出来仍是旧的 `阈值 3.0`，**210 条 net 未分层**，看起来像"预设没改好"。
  修法：新增 `PRESET_REV`（预设版次，改预设内值即 +1），载入时若存档版次落后且存的是某个预设，
  就**只套用新预设、丢弃旧的逐项覆盖值**并在输入页提示一句；「自定义」或版次一致时照旧恢复用户微调。
  另在预设旁新增**「套用预设」按钮**（下拉重选同一项不触发 change，此前无法手动重套）。

### 测试

- 新增两个 `#[ignore]` 真实数据测试（本地手工运行，含 4 个 TDQ 文件的 AC 标定对照与确定性复核）：
  `cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture`。
- 新增**筛选文件命中诊断** `pwr_filter_diagnose`（同上命令）：逐个 PWR 名单打印
  "白名单条数 → 命中 net 数 / pin 数分布 / 未匹配示例"，用于排查"名单里的 net 没被分层"。

### 修复

- **筛选文件"命中 0"时给出可定位的提示**（`io/xlsx.rs`）：此前只报
  "保留 0 个 net（剔特殊网/单 pin 后 N 个）"，看不出是**名字对不上**还是**表里有但只有 1 个 pin**。
  现在分两条：① 整份名单无交集时给出显式告警（提示核对名单与 pin 表是否同源）；
  ② 常规统计追加"名单 N 条中 M 条未匹配到表内 net"。
  典型场景：`LIST\PWR_VDD1_SENSE.lst`（640 个 `*_DPS_S1a`）在 `1165P_3D.xlsx` 里
  **每个 net 都只有 1 个 pin**，被"单 pin 剔除"规则挡掉 → 0 net 分层；
  同目录 `PWR_VDD1_IN.lst` / `PWR_VDD2_*.lst` 名字同源，分别命中 640 / 1165 个 net。
  详见 [core-plugins/probe-rat-layer/README.md](core-plugins/probe-rat-layer/README.md) 的
  "筛选文件里的 net 没被识别/没被分层"一节。

### 文档

- **修订"核心插件只剩 core-example"的过时表述**（探针卡分层 2026-09 转为 native 核心插件后未同步）：
  - [README.md](README.md)：教学基线段、核心插件小节、目录说明改为"core-example（教学示例）+
    probe-rat-layer（真实算法）"；
  - [docs/操作手册.md](docs/操作手册.md)：§3.1 业务命令说明（改为"当前唯一业务命令面 = `layer.*`"）、
    §3.7 核心插件 cdylib、§4.2 浮窗内容（改为"声明 `float` 的已启用插件"）、§5 里程碑表、
    §7 已知边界、§8 学习路线（原引用已删除的 `core-plugins/notes` 数据流与 crate）；
  - [docs/技术栈与概念详解.md](docs/技术栈与概念详解.md) §3.6、[docs/核心插件示例教程.md](docs/核心插件示例教程.md)
    （补真实工具级示例入口 + 完整 manifest 字段）、[docs/插件开发指南.md](docs/插件开发指南.md)
    §0.2 `_core` 目录示例（`core-notes` → `core-example`/`probe-rat-layer`）；
  - [scripts/build-core.mjs](scripts/build-core.mjs) 顶部注释同步（仅注释，无行为变化）。

## [0.4.5] — 2026-09-08

**主题持久化彻底修复（皮肤主题重启常驻）** + **消除启动白闪** + **皮肤主题/启动画面完全同色**。

### 变更

- **主题持久化重写（皮肤主题重启常驻）**：把"渲染"与"落盘"解耦——`applyTheme` 改为**纯视觉、
  永不持久化**；主题 id 只在**用户显式选择**时经新入口 `setThemeId`（设置页/引导页/顶栏切换）
  落盘。从而杜绝"启动打底色 / plugin 就绪重放"把回退值（如 `system`）写回、覆盖用户保存的
  `theme-midnight`。
- **启动恢复只读**：启动 IIFE 从 **Rust app.json** 权威读取主题（`resolveAuthoritativeTheme` 优先
  任意来源非 `system` 真实值），仅设置 `themeId` 渲染、**不落盘**；回退 watch 改**纯渲染兜底**，
  不再改写 `themeId`（历史上正是它把 id 改成 `system` 又落盘）。
- **消除启动白闪（延迟显示窗口）**：主窗口 `visible:false` 启动即隐藏；前端在主题已解析、dark
  splash 已绘制后 `window.show()`——用户看到的是所选主题底色的"正在启动"动画，绝不先冒白。
  ⚠️ 关键：`window-state` 插件默认 `StateFlags::all()` 含 `VISIBLE`，恢复时会重新 `show()` 窗口、
  恰好绕过 `visible:false`（白闪仍在的根源）。改为 `with_state_flags(SIZE|POSITION|MAXIMIZED)`
  **不含 VISIBLE**，可见性完全交由前端延迟显示控制。
- **原生窗口底色**：`lib.rs setup` 用 `theme_bg_rgb` 读 `app.json` 的 `themeBase/theme`（含精确
  `themeBg`）设 `set_background_color`，双重保险；Rust 侧 **4s 兜底强制显示**（前端异常不卡死）。
- **启动画面与主题完全同色**：`setThemeId` 把所选主题的**精确画布背景色**（`--bg`，如
  `theme-midnight` 的 `#101418`）一并持久化（`toolbox.theme.bg`/Rust `themeBg`）；splash 背景改用
  `var(--boot-bg)`（启动时由 `setBootBackground` 设为主题精确色），不再只近似的 dark/light。
- **启动过渡**：splash 淡出 + 主界面淡入（`.boot-fade` / `.app-fade-in`，240ms），不再"蹦出来"。

### 修复

- **启动白闪**：此前尝试在 `index.html` 内联脚本提前上色，但被 CSP `script-src 'self'` 拦截、
  生产包不生效，已移除；改为原生窗口底色 + 延迟显示窗口（真正生效）。

## [0.4.4] — 2026-09-08

探针卡分层**net 输入规则重做** + **筛选文件大小写不敏感 / 多选并集** + **已选筛选文件 UI 改进** + **宿主进程免黑窗口**。

### 新增

- **支持多个筛选文件**：`layer.run` 的 `filter` 可传多个（数组取并集作为白名单）；前端筛选文件浏览器支持
  **多选**（点选切换、确认"选择 N 个筛选文件"），配置持久化 `lastFilters`（兼容旧 `lastFilter`）。
- **已选筛选文件醒目展示**：从一行小字改为**卡片列表**——数量徽标 + 每个文件一行
  chip（序号 + 文件名 + 完整路径 + × 移除按钮），一眼可见；未选时显示占位提示。
- **宿主进程免黑窗口**：process 插件启动、pip 安装依赖、`taskkill` 均加 `CREATE_NO_WINDOW`，且
  解释器解析优先 `pythonw.exe`（无控制台），不再弹黑色控制台窗口。

### 变更

- **net 输入规则重做（不再按名分类）**：读入 pin 表后**只剔特殊网**（空名 / `NC` / `GND`，含 `===` 前缀、
  大小写不敏感）与单 pin，其余**一律当信号网**；移除 `Signal/Power/Ground` 启发式分类（`classify_net`），
  GND 不再特殊剔除、电源网不再特殊处理（**取代** 0.4.3 的"只剔 GND+单pin、VDD 保留并布线"与 0.4.2 的分类）。
- **筛选文件匹配改大小写不敏感**：`.lst/.txt` 白名单与 pin 表 `NET_NAME` 归一化为大写比对
  （此前精确匹配——对"小写 .lst vs 大写 NET_NAME"的数据会误剔为 0 个 net）。
- **筛选文件放分层前最后一步**：先剔特殊网/单 pin，最后按筛选文件保留，之后才生成飞线分层。
- **DC 信号预设改为"质量优先"**：算法默认项调高（`resolve_conflict_rounds=15`、`sa_restarts=3`、
  `sa_initial_temp=12`），并**开启拥塞均衡**（`congestion_balance=true`, `congestion_balance_passes=40`）；
  层数 4 / 线宽 0.2 不变，计算时间略长。实测该套参数对真实数据取得 **0 需人工 / 0 硬冲突 / 层占用 ≤1.0**。
- **主题持久化彻底修复（皮肤主题重启常驻）——重写为"纯渲染 + 唯一落盘"解耦设计**：
  此前 `applyTheme` 在**每次渲染都持久化**，于是启动打底色（`main.ts`）与插件就绪后的
  `watch` 重放——只要某刻 `themeId` 被解析成可解析的 `system`/默认值——都会把该值**写回**
  Rust app.json 与 localStorage，覆盖用户保存的皮肤主题（如 `theme-midnight`）。（前一轮只加
  `{persist:false}` 封住了 `main.ts` 一个入口，`App.vue` 的 watch 仍默认 `persist:true` 在写。）
  现改为：
  - `applyTheme(id)` **纯视觉、永不持久化**（取消 `persist` 选项）；主题 id 只由
    **`setThemeId(id)`** 在**用户显式选择**（设置页/引导页/顶栏切换）时经 `selectTheme` 落盘；
  - 启动恢复（`App.vue` 启动 IIFE）从 **Rust app.json** 权威读取 → `resolveAuthoritativeTheme`
    （优先任一来源非 `system` 真实值）→ 仅设置 `themeId` 渲染，**读取不落盘**；
  - 回退 watch 改为**纯渲染兜底**（皮肤插件被禁用/卸载、无效自定义才就地渲染默认/跟随系统），
    **不再改写 `themeId`**（改写会连带触发再应用+再落盘，正是历史上把 id 改成 `system` 的源头）。
- **消除启动白闪**：改为**延迟显示主窗口**（比"改底色"更彻底——窗口从不在未渲染/白色状态出现）：
  - 主窗口 `visible: false`（启动即隐藏），前端在**主题已解析、暗色 splash 已绘制**后调
    `window.show()`——用户看到的就是所选主题底色的"正在启动"加载动画，绝不先冒白；
  - ⚠️ **关键修复**：`window-state` 插件默认 `StateFlags::all()` 含 `VISIBLE`，恢复时会重新
    `show()` 窗口、恰好绕过 `visible:false`（这就是白闪仍在的原因）。改为
    `with_state_flags(SIZE | POSITION | MAXIMIZED)` **不含 VISIBLE**，可见性完全交由前端延迟显示控制；
  - 保留**原生窗口底色**（`lib.rs setup` → `theme_bg_rgb` 读 `themeBase/theme` 设
    `set_background_color`）作双重保险；`applyTheme` 未解析分支按**持久化 base** 打底、
    `setThemeId` 把所选主题的**基础模式**一并持久化（`toolbox.theme.base` / Rust `themeBase`）；
  - 启动对只有旧主题 id、尚无 base 的用户**回填一次 base**（只写 base，不写 id）；
  - Rust 侧 **4s 兜底强制显示**（前端异常时不至于窗口永久隐藏）；splash 淡出 + 主界面淡入平滑过渡
    （`.boot-fade` / `.app-fade-in`）。此前内联脚本方案被 CSP `script-src 'self'` 拦截、不生效，已移除。

## [0.4.3] — 2026-09-04

探针卡分层**数据过滤规则敲定** + **移除旧 JSON 加载器** + **筛选文件强制必填**。

### 变更

- **数据过滤只剔 GND + 单pin，其余全保留**：加载时即剔除 `GND`（及 `VSS/AGND/DGND/SGND/GROUND`）类 net 与单pin net；多pin 电源网（如 `VDD`）**保留并生成飞线、参与分层**（此前电源/地走 plane 不进布线）。
- **移除旧 JSON 加载器**：删除 `allegro_json` 输入路径，以后仅支持 `.xls/.xlsx` 表格导入；非表格输入报「仅支持 .xls/.xlsx 表格输入」。
- **筛选文件强制必填**：运行分层前校验必须提供筛选文件（.lst/.txt/.xls/.xlsx），未提供/越出可读范围/不存在均报错；前端「输入 2」标为必填、去掉「清除」按钮、首启向导与运行均校验必填；「全量（不筛选）」预设不再清空筛选文件并改名「全量（细格 0.5 / 阈值 0.8）」。

> 📌 说明：当前 `hv_all.lst` 含 1800 个 HV 信号网、无 GND/VDD 网名，故本次改动对现有数据集结果不变；GND 剔除、VDD 布线在数据含电源/地网（且列在筛选文件里）时生效。

## [0.4.2] — 2026-09-03

宿主能力改走官方 Tauri 插件（减手写代码）+ 探针卡分层质量/可诊断性提升 + 结果跨运行稳定。

### 新增

- **剪贴板 / shell.exec 改走官方插件**：`clipboard.read/write` → `tauri-plugin-clipboard-manager`；
  `shell.exec` → `tauri-plugin-shell`（命令/权限/参数/返回不变，减手写代码）。
- **外壳日志带插件名**：native 插件日志前缀由 `[plugin:log]` 改为 **`[plugin:<插件id>]`**，多插件可区分来源。
- **探针卡分层详细日志**：任务开始/读入输入/配置/分层完成(汇总+逐层)/导出/失败与取消，全部写宿主
  日志（`[plugin:probe-rat-layer]`），便于出错定位。
- **探针卡"后处理拥塞均衡"**：把超容层/格点上的线平衡到低拥塞允许层，摊平圆心层占用峰值；实测
  **峰值 1.56→1.11、走通率(洪泛)→~100%**，需人工/冲突不变。默认关闭（`拥塞均衡` UI 开关可开）。

### 变更

- **拥塞均衡改"拥塞+交叉感知"**：新增 `congestion_balance_cross_weight`(默认 0.5)，移动判据同时看
  拥塞溢出与同层交叉，压峰值的同时不致交叉回升（对比旧均衡把同层交叉推到 2547，此版 ~2095）。
- **分层默认值适度调高**：`resolve_conflict_rounds 8→12 / balance_length_rounds 3→6 /
  minimize_crossings_passes 3→6 / sa_restarts 1→2`（不调 `sa_max_steps`，实测更差）。
- **结果跨运行稳定**：算法模块 `HashMap`/`HashSet` 改用确定性哈希（`FxHashMap`/`FxHashSet`），同配置
  多次运行结果完全一致、可复现。
- **`shell.exec` 输出走临时缓存文件**：内存全程 O(1)，结束时仅读末尾 40 行，超大输出不驻留内存。

### 修复

- **走通率显示健壮性**：缺失字段返回「—」而非 `NaN`。
- **输出目录未创建被拒**：`within_workspace` 改用 `path_within`，不存在子路径正确判在工作区内并自动创建。
- **短线容忍可配置**：`short_segment_len`/`short_segment_crossing_factor`（默认=现状）。
- **CI 资源占位**：`ci.yml`/`build-release.yml` 在 `cargo test` 前创建 `resources/_core`、`bundled-plugins`。

## [0.4.1] — 2026-09-03

文件输入(Inbox) 目录 + 探针卡首次配置向导；走通率升级为"真实可布"（连通分量洪泛）指标；
短线容忍可配置（默认=现状）；结果只保留最新一组；输出目录自动创建 + 走通率显示健壮性；
全部配置项说明完善（参数速查卡 + 效果/推荐范围）。

### 新增

- **文件输入(Inbox) 目录**：数据根下新增 `Input/` 作为统一"输入/收件"目录（`TB_INBOX` 注入插件
  进程），支持拖拽导入/建目录/重命名/移动/删除/打开；`input_*` 命令接入，输入文件可作为分层源。
- **探针卡分层首次配置向导**：插件首次打开时引导设置数据根/工作区（`settings.configured` 门控），
  避免未配置即计算报错。
- **走通率"真实可布"指标**：新增 `post_process::routable_nets_flood`——按层在"容量内可走"栅格
  （supply>0 且 occupancy≤layer_capacity）做 4 邻接连通分量洪泛，判定每条 net 的线端是否落在
  **同一连通可布区**，比直线/路径占用峰值更诚实（走直线即使超容，只要层内存在容量内绕行通道就算可布）；
  接入报告/摘要/结果页 `routable_flood_net_count/ratio/unroutable_nets_flood`。纯诊断、不改分层。
- **算法深化基线（hv 1800 网，release）**：直线 77% / 路径 80% / **洪泛 98%**，层占用峰值 1.78（>1.0）。
  结论：分层本体可行（98% 网可在容量内绕行），瓶颈是**圆心/内枢拥塞**——后续算法改进均以此为 A/B 基准。
- **短线容忍可配置项**：`config.rs` 新增 `short_segment_len`（mm，长度 ≤ 该值视为短线，默认 0=关闭）
  与 `short_segment_crossing_factor`（短线交叉的硬冲突阈值放大系数，默认 1=不放大）；
  `conflict_classifier` 在硬阈值检查前判 `is_short` 并按系数放大阈值，硬判 reason 记为
  `crossing_hotspot_short`。**默认值=现状，不改分层结果**。

### 变更

- **结果只保留最新一组**：`dispatch.rs` `cmd_run` 运行前 `prune_jobs`（删光历史 job 目录）+ 清空 jobs
  map；`restore_jobs` 只保留最新一条 job。用户成果物（report/lst/csv）不受影响（覆盖写，不清理）。
- **全部配置项说明完善**：`ui/App.vue` 所有参数 hint 重写为"效果 + 推荐范围 + 默认值"，新增「参数速查」
  总览卡（质量vs速度、最关键旋钮、推荐路径）；修正"硬冲突阈值越大层越少/人工线越多"→
  **越大越宽松（硬冲突/需人工越少，但同层交叉更多）**。

### 修复

- **输出目录未创建被拒**：`within_workspace`/`within_read` 改用新建 `path_within`（`norm_abs`：存在则
  canonicalize、不存在则对最近存在祖先 canonicalize 再追加剩余组件；去 `\\?\` 前缀 + 大小写/组件边界判定），
  使不存在的子路径正确判在作用域内，`create_dir_all` 自动创建输出目录。
- **走通率显示健壮性**：三个 `routableRatio*` 对缺失字段返回「—」而非 `NaN`。
- **CI 资源占位**：`build-release.yml`/`ci.yml` 在 `cargo test` 前创建 `resources/_core`、
  `resources/bundled-plugins` 占位目录，修复 `resource path resources\bundled-plugins doesn't exist`。

## [0.4.0] — 2026-09-03

探针卡分层可布性度量（走通率）+ 三种新预设（AC/POWER）+ 里程碑 0/1/2（配置化/诊断）
+ pin 邻近硬约束。

### 新增

- **探针卡分层新增 AC / POWER 预设**：预设下拉新增「AC（细线 0.1mm / 12 层）」与
  「POWER（宽线 8mm / 20 层）」，其余参数与 DC 信号预设一致（cell 2.0 / threshold 3.0 / 0.2 间距 /
  packing + sa）；层数输入上限 16 → 40，以容纳 POWER（20 层）。纯 UI 预设，改线宽+层数后由后端直接生效。
- **走通率指标（探针卡分层）**：新增 `post_process::routable_nets`——对每条已分配 net，在其被分配层
  内按**直线路径占用峰值 ≤ `layer_capacity`** 判定可布；接入报告 `summary`（`routable_net_count` /
  `total_net_count` / `routable_ratio`）、文本摘要与结果页「走通率」卡片。纯诊断、不影响分层结果。
  实测（`hv` 预设，1800 网，release）：**走通率 ≈ 80%**，且暴露层占用率 > 容量 1.0 的**残留拥塞**信号
  （为后续"模拟走线路径"版走通率与更好分层打底）。见 [探针卡分层算法-学习导言](docs/探针卡分层算法-学习导言.md)（走通率指标）。
- **里程碑 0 软同 net（配置化 v1）**：`LayeringConfig.same_net_via_penalty`（λ；默认 0=完全按段=现状，
  >0 启用"先整网、放不下按段拆"的两级决策）。配套 `post_process::net_span_stats` 产出 **`multi_layer_nets` /
  `via_estimate`**（跨层 net 数 / 估算过孔数），接入报告与摘要。
  **⚠️ 数据发现**：当前真实数据 `1.xlsx+hv_all.lst` 为 **100% 2-pin 网（1800 网/0 多pin 网）**，每网仅 1 段，
  本就无法跨层 → **此数据上两指标恒为 0、里程碑 0 收益无法体现**；该路径仅在含多段网的板子上才有意义，
  **须用真实多段板验证后再启用 λ**。λ=0 与现有解完全一致、λ=1 质量持平/略优（无回归）。
- **里程碑 1 · 走通率"模拟路由路径"版**：`geometry::estimate_route` 按层 `preferred_dir` 生成曼哈顿 L/Z
  估计路径（带 margin 避开禁布区），`post_process::routable_nets_path` 判路径占用 ≤ `layer_capacity`；
  接入报告/摘要 `routable_path_net_count` / `routable_path_ratio`。纯诊断、不影响分层。
  实测：此放射状 2-pin 数据上 **走通率(路径) ≈ 走通率(直线)**（约 78%）——路径紧贴直线廊道；
  路径版在**含 keepout/非规则走线**的板子上才更有区分度。后续把模拟路径接入**分层算法的拥塞/冲突模型**
  才是里程碑 1 的真正价值（改动分层行为，待评估）。
- **里程碑 2 · 拥塞平滑代价 + 迭代整网 reroute（配置化）**：`LayeringConfig.congestion_k`（k，代价幂次，
  默认 2.0）与 `ripup_rounds`（迭代轮数，默认 0=关）——`_reroute_rounds` 按 `Σ(occupancy)^k` 平滑代价，
  反复把高拥塞层上的**整单元**搬到更低拥塞且无硬冲突的层（整单元移动=不引入过孔）。默认关=保留现有结果。
  **实测（此放射状 2-pin 数据）**：启 8 轮后 **未能降低最大层占用（仍 1.78）且轻微劣化**（需人工 2→6、
  已分配 1798→1794）——该数据上的拥塞**无法靠整网搬动解决**，需真实复杂板验证。

### 变更

- **发布流程文档重写**：[docs/发布流程.md](docs/发布流程.md) 区分「CI 全自动（路径 A：tag 触发
  build-release.yml）/ 本地签名构建（路径 B：`pnpm tauri build`，未配 Secrets 时用）」，修正同步范围
  （4 个 crate）与 clippy 命令（`--no-deps`，并强调**打包前跑 release 档**）。
- **文档体系梳理**：新增 [docs/README.md](docs/README.md) 文档索引（定位/状态/交叉引用/阅读路径）；
  探针卡分层 Rust 化标注为**已实施**；操作手册 / 插件开发指南 补上真实算法核心插件 **probe-rat-layer**。

### 修复

- **清理 release 档 dead_code 警告**：移除无调用方的 `save_removed_bundled`（仅在 release 档
  `cfg(dev)` 不生效时触发，CI debug 档不会暴露）；打包前 `cargo clippy --release -D warnings` 归零。
- **探针卡分层 pin 邻近**：新增端点(pin)邻近判定——不同 net 的 **pin 间距放大到线径（线宽）**，
  任一端点(pin)对距离 < `max(线宽_a, 线宽_b)` 时判为**硬冲突**，**严格要求不同 net 的 pin 不能靠太近**
  （同层放不下）。同时把 `pair_candidates` 的 bbox 各向膨胀 `expansion_radius`，**确保"原始 bbox 不交但
  引脚邻近"的线对也能进入候选**，否则会被漏判。实测（width8 / 20 层）：**同层 pin 邻近违规 = 0**，
  需人工 255（线径越大约严；密板物理上放不下 8mm pin 间距的网，真实 POWER 板会少）；
  width0.2 基线基本不变（1798 / 需人工 2 / 硬冲突 272）。

## [0.3.0] — 2026-09-02

探针卡分层插件核心重写（Python + 130MB vendor → Rust native cdylib），算法提质提速，
前端与插件系统多项 Bug 修复与 UI 统一。

### 变更

- **探针卡分层插件（probe-rat-layer）计算核心 Rust 化**：原 process Python（vendor 130MB）
  改写为 **native cdylib 核心插件**（`tb_probe_rat_layer.dll`，随应用分发），零 vendor、
  性能接近进程内直接调用；命令/事件/前端契约**完全不变**，宿主沿用 `libloading + C ABI`
  加载。jobs/cache/settings 落在应用配置目录 `probe-rat-layer/`，重启恢复上次任务
  （见 `core-plugins/probe-rat-layer/` 与算法[学习导言](docs/探针卡分层算法-学习导言.md)）。
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
  预设），输出指标便于核对；见 [探针卡分层算法-学习导言](docs/探针卡分层算法-学习导言.md)。

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
