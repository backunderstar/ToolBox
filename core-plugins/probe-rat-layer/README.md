# 探针卡分层（ToolBox 核心插件，native）

> id：`probe-rat-layer` · 形态：**native cdylib 核心插件**（`tb_probe_rat_layer.dll`）·
> 计算核心：**Rust**（零 vendor，替代原 Python + 130MB 依赖版）。

## 作用

Allegro pin 表（xls/xlsx）→ 剔特殊网（空/NC/GND，含 `===` 前缀）与单 pin、其余**不分类一律当信号网**
→ 按筛选文件（.lst/.txt）保留（**分层前最后一步**，**大小写不敏感**、与 pin 表 NET_NAME 对齐；
支持**多选多个文件**，名单取**并集**）→ 分层 →
`layer_N.lst`（供 Allegro 导入）+ `report.json` + CSV。自带 Vue 前端（`ui/`，侧边栏「探针卡分层」）。

## 分层算法（方案 B：效率+质量）

`layer_packing.rs`（主方法 `packing`）实现了面向效率与质量的改进：

- **MFPS 网络排序 + 方向感知贪婪铺层**（初值）：按"最难优先"（硬冲突度降序，再按线长降序）
  排单元；逐单元放到"方向匹配（H→H 层、V→V 层，读取 `LayerStack.preferred_dir`）优先、
  当前负载最小"的允许层。替代原"按角度轮询"，减少后期冲突消除负担。
- **边驱动硬冲突消除**（`_resolve_conflicts`）：从硬冲突图边构建"同层不同单元"坏单元集合，
  就近挪到无冲突允许层。复杂度 O(边数+坏单元×邻接度)，替代逐轮两两扫描 O(n²)。
- **增量容量强制**（`_enforce_capacity`）：移动判定只在该单元覆盖的格点上算占用量，提交时
  增量更新需求栅格，不做整栅格 clone + 全量 `max` 扫描。
- **模拟退火邻接表化**（`optimizer.rs`）：`hard_conflict_in` 由遍历整层 wires 改为扫描该线
  硬冲突邻接，每步 O(deg)。

实测（`hv` 预设，1800 网，release）：**1.74s**（旧版 73.6s，~42×），已分配 1798、
硬冲突 272、软冲突 23818、需人工 2（旧版 1781 分配 / 19 人工）。可用
`cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture` 复测（需真实数据路径）。

## 架构

```
dispatch.rs   命令分发 + 后台任务引擎 + 状态恢复（对应宿主动态库的 tb_call）
  ├─ layer.listDir/config/run/status/cancel/result/readOut/render/openOut/report/notifyDone/plugin.action
  └─ 后台线程：load → pipeline::run（进度/取消）→ report 导出 → jobs/<id> 落盘
pipeline.rs   编排（run_once：分信号/电源地(实际 GND 已剔除、Power 当信号) → 拥塞 → 冲突检测 → 分层 → 后处理）
io/           calamine 读 xlsx（.xls/.xlsx 表格）/ Prim MST 飞线
config/模型      LayeringConfig + 数据模型（model.rs）
core 算法模块    geometry/keepout/congestion/conflict_classifier/layer_packing/
                optimizer(SA)/graph_coloring(Dsatur)/layer_stack/metrics/post_process
report.rs     report.json / layer_N.lst / layer_nets.json / *.csv
viz.rs        plotters 按需渲染 layer/overview/rose/manual → PNG(base64 data URL)
```

## 命令 / 事件契约（与前端一致，勿改）

命令：`layer.listDir` `layer.config` `layer.run` `layer.status` `layer.cancel`
`layer.result` `layer.readOut` `layer.render` `layer.openOut` `layer.report`
`layer.notifyDone` `plugin.action`。

`layer.run` 参数：`input`=pin 表（.xls/.xlsx）；`filter`=**筛选文件路径或多个（数组取并集）**；
`outDir`=输出目录（必填）；`layers`/`width`/`clearance`/`config`=分层与算法参数。

事件：`layer.progress`（实时补充）`layer.done` `layer.cancelled` `layer.failed`。

关键点：

- **异步任务模型**：`layer.run` 秒回 `jobId`，后台线程跑真实分层；前端**轮询
  `layer.status`**（含 camelCase `jobId`）驱动进度，完成时收 `layer.done`。
- **`layer.render`**：返回 PNG **base64 data URL** 字符串；native 版同步渲染（无宿主 30s
  超时），前端拿到字符串即缓存秒开。
- **进度/取消**：后台线程经 `crate::state::Progress` 更新共享状态 + 检查 `Arc<AtomicBool>`
  取消标志；`LayerState::Drop`（`tb_destroy` 时）取消并 join 后台线程，避免 use-after-free。
- **工作区**：`tb_create` 注入 `{"vault":当前工作区,"config_dir":应用配置目录}`；
  未配置工作区（vault 为空）时插件照常启动，需要工作区的命令在调用期报错。
- **jobs/cache/settings** 落在 `config_dir/probe-rat-layer/`；分层成功写
  `jobs/<id>/meta.json`，插件重启后 `restore_jobs` 恢复上次 `done` 任务。

## 打包 / 接线

- `Cargo.toml`：Cargo workspace 成员，`[lib] crate-type=["cdylib","rlib"] name="tb_probe_rat_layer"`。
- `scripts/build-core.mjs`：PLUGINS 数组加项（`dir:"probe-rat-layer"` `crate:"tb-probe-rat-layer"`
  `dll:"tb_probe_rat_layer.dll"`），`pnpm build:core` 产出 DLL + `ui/*.js` 部署到
  `plugins/_core/probe-rat-layer/`。
- 随应用分发（`bundle.resources` 的 `_core`），首启 `ensure_core_plugins` 部署；**默认启用**
  （核心插件语义），管理类命令不依赖工作区。

## 预设（UI 一键套用，见 `ui/App.vue::applyPreset`）

| 预设 | 层数 / 线宽 / 线距 | 关键参数 |
|---|---|---|
| DC 信号（默认） | 4 / 0.2 / 0.2 | cell 2.0、阈值 3.0、质量优先 + 拥塞均衡 |
| **AC** | **11 / 0.1 / 0.1** | cell 2.0、**阈值 4.8**、**热 SA(20/0.9998/0.9)**、**护栏 2.5**、拥塞均衡 |
| POWER | 20 / 8 / 0.2 | cell 2.0、阈值 3.0 |
| 全量 | 4 / 0.2 / 0.2 | cell 0.5、阈值 0.8（严） |

AC 预设用项目现成的 4 个 TDQ 筛选文件（`AC_TDQ0/1/8/9`，并集 4660 网）实测定参：
**需人工 0 / 同层交叉 2492 / 层线数失衡 0.094 / 扇区失衡 0.035 / 占用峰值 1.00 / 洪泛走通 100%**。
（2026-09-28 pin 表换为 `1165P_3D_new.xlsx` 后复测；旧表基线为 2482 交叉 / 峰值 0.89，参数未变。）
标定表与推导见 [HANDOVER §1.34](../../HANDOVER.md)。

## 同 net 整网归层（3-pin = 2 段线尽量同层）

3-pin 网拆成 **2 段飞线**、≥4-pin 网拆成 MST 多段——**同一 net 的多段尽量落同一层**（少过孔、
少跨层），只有该层放不下时才跨层。实现 = `post_process::consolidate_same_net_layers`
（分层/SA 之后整网挪层；判据含**硬冲突检查 + 层均衡上限**，因此只减跨层、不新增硬冲突）：

| 旋钮 | 默认 | 作用 |
|---|---|---|
| `same_net_consolidate` | **true** | 开关。关掉即回到"按段独立分层"（改动前行为） |
| `same_net_merge_slack` | 1.15 | 目标层线数上限 = 候选层平均线数 × 本系数（防合并把线堆到一层） |

实测（`VDD1_SENSE ∪ DC_VFSBLN_IN` = 1280 net / 1362 飞线；其中**多段网 82 个 / 164 段**）：

| 层数 | 指标 | 关闭归层（改动前） | **开启归层（默认）** |
|---|---|---|---|
| 4 | 跨层 net / 过孔 | 65 | **0** |
| 4 | 层线数失衡 | 0.0385 | **0.0089** |
| 4 | 同层交叉 | 1132 | 1327（+195） |
| 4 | 峰值 / 需人工 / 洪泛 | 1.33 / 12 / 1264 | 1.33 / 12 / 1260 |
| 6 | 跨层 net / 过孔 | 68 | **0** |
| 6 | 层线数失衡 | 0.1057 | **0.0088** |
| 6 | 同层交叉 | 414 | 535（+121） |
| 6 | 峰值 / 需人工 / 洪泛 | 0.89 / 0 / 1280 | 1.11 / 0 / 1280 |

即：**用 +121～+195 条同层交叉，换掉全部 65～68 个跨层 net（过孔归零）+ 层均衡提升一个量级**。
复现：`cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture same_net_layer_sweep`

## 分层质量调参（DC 预设，允许牺牲时间）

用户场景（1280 net / 1362 飞线）逐项对照，结论：

| 档位 | 已分配 | 需人工 | 同层交叉 | 峰值 | 层线数失衡 |
|---|---|---|---|---|---|
| DC 现状（4 层） | 1350 | 12 | 1327 | 1.33 | 0.0089 |
| SA 重启 10 + 初温 20 | 1350 | 12 | **1276** | 1.33 | 0.0030 |
| 硬冲突阈值 3.0 → **4.8** | **1362** | **0** | 1347 | 1.33 | **0.0029** |
| 阈值 4.8 + 热慢 SA + 均衡 200 | 1362 | 0 | 1389 | 1.33 | 0.0029 |
| **6 层 + 阈值 4.8 + 热慢 SA** | **1362** | **0** | **640** | **1.11** | 0.0088 |

- **"0 需人工 + 每层均匀"只要把硬冲突阈值提到 4.8**（层线数失衡 0.0089 → 0.0029）。
- **同层交叉要显著下降只能加层**（6 层：1327 → 640，同时峰值 1.33 → 1.11）；4 层的交叉降不动。
- 4 层峰值 1.33 是**几何下限**（放宽阈值/容量都不变）。
- 复现：`cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture real_data_dc_quality_sweep`

## 测试

`cargo test -p tb-probe-rat-layer --lib`：pipeline 合成数据 / geometry / config 覆盖 /
扇区索引 / report 往返 / dispatch 命令路由 / **FFI ABI 冒烟**（libloading 直接加载 DLL）。

真实数据（`#[ignore]`，本地手工跑 `cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture`；
数据在 `D:\ToolBoxData\Project\1165P_3D`，pin 表 = `1165P_3D_new.xlsx`）：

- `real_data_ac_sweep`：AC 预设标定对照表 + 确定性复核（1165P + 4 个 TDQ list）；
- `real_data_dc_preset_regression`：**DC 回归守护**（锁 `已分配 1798 / 需人工 2`，防 AC 标定波及 DC）；
- `real_data_pwr_sense_layering`：对单个 PWR 名单真跑分层（`PWR_VDD1_SENSE` / `PWR_VDD1_IN`），
  打印 net 数 / pin 数分布 / 已分配 / 需人工 / 同层交叉 / 洪泛 / 占用峰值；
- `real_data_pwr_filter_diagnose`：逐个 PWR 名单只看读入命中情况（不跑分层，秒级）；
- `real_data_pwr_dc_layering`：DC 预设下"单名单 / 组合 / 4-5-6-8 层扫描 / 放宽约束对照"；
- `real_data_dc_quality_sweep`：DC 预设分层质量参数扫描（SA 温度/冷却/重启、交叉轮数、阈值、层数）；
- `real_data_same_net_layer_sweep`：同 net 整网归层的 A/B（关/开/软偏好/硬整网/上限放宽，4 与 6 层）；
- 另有历史基线测试（hv 1800 网、POWER width8 pin 邻近等）。

## 常见问题：筛选文件里的 net "没被识别/没被分层"

分层前有**两道**淘汰，任一都会让名单里的 net 不出现在结果里（`load_xlsx` 的 warnings 里会给出条数）：

1. **单 pin 剔除**：`pin` 表里该 net 只有 1 个 pin → 无法成飞线，直接丢（发生在白名单筛选**之前**）。
2. **白名单无交集**：名字与 pin 表不一致（大小写不敏感，但**后缀必须完全一致**）→ 整份名单落空。

**历史案例（旧 pin 表 `1165P_3D.xlsx`）**：`LIST\PWR_VDD1_SENSE.lst` 的 640 个 net
（`*_DPS_S1a` 形态）在旧表里**每个都只有 1 个 pin**（表的单元格只引用了 X 变体），
全部被"单 pin 剔除"挡掉 → 0 net——**不是识别 bug，是名单与 pin 表不同源**。

| 名单 | 旧表（`1165P_3D.xlsx`） | 新表（`1165P_3D_new.xlsx`，2026-09-28） |
|---|---|---|
| `PWR_VDD1_SENSE.lst` | 全部 1 pin → **0 个 net** | **640 个 net，全部 2 pin** |
| `PWR_VDD1_IN.lst` | 2 pin × 115、3 pin × 525 → 640 个 net | 全部 2 pin → 525 个 net（115 条名单未匹配） |
| `DC_VFSBLN_IN.lst` | 2 pin × 115、3 pin × 525 → 640 个 net | **640 个 net（2 pin × 115 + 3 pin × 525），722 飞线，命中 640/640** |
| `PWR_VDD2_Sense.lst` / `PWR_VDD2_Force.lst` | 2 pin / 12 pin → 1165 / 1165 | 同左（2 pin / 12 pin） |

### DC 预设 + 名单组合的实测（新表，4 层 / 0.2 / 0.2）

`VDD1_SENSE ∪ DC_VFSBLN_IN`（两份各 640 条，全部命中）= **1280 个 net（755 个 2-pin + 525 个 3-pin）
/ 1362 飞线**，DC 预设下：

| 层数 | 已分配 | 需人工 | 同层交叉 | 占用峰值 | 洪泛 |
|---|---|---|---|---|---|
| **4（用户指定）** | 1350 | **12** | 1132 | **1.33（超容）** | 1264/1268 |
| 5 | 1353 | 9 | 671 | 1.11（超容） | 1270/1271 |
| **6** | **1362** | **0** | 414 | **0.89** | **1280/1280** |
| 8 | 1362 | 0 | 150 | 0.89 | 1280/1280 |

- 4 层装不下：圆心处的**拥塞几何下限**是 1.33——放宽硬冲突阈值（12.0）或放开层容量（10.0）
  峰值都仍是 1.33，与冲突/容量约束无关；要"0 需人工 + 不超容"需要 **6 层**。
- 单跑各 640 个 net 时 4 层都够：`VDD1_SENSE` 峰值 0.89 / 0 需人工 / 同层交叉 208；
  `DC_VFSBLN_IN` 峰值 0.89 / 0 需人工 / 同层交叉 198。
- 复现：`cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture pwr_dc_layering`

排查手法（新表上也会打印同样的信息）：
`cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture pwr_filter_diagnose`
逐个 PWR 名单打印"白名单条数 → 命中 net 数 / pin 数分布 / 未匹配示例"；
要看分层结果用 `... pwr_sense_layering`（单名单）或 `... pwr_dc_layering`（组合 + 层数扫描）。

## 与旧版的关系

原 `plugins/probe-rat-layer`（process Python，130MB vendor，异步任务 + 按需渲染）已改写为
本 native 核心插件；前端 `ui/` 与宿主命令/事件契约**保持不变**。算法与实现要点见
[学习导言](../../docs/探针卡分层算法-学习导言.md)。
