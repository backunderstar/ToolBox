# 探针卡分层（ToolBox 核心插件，native）

> id：`probe-rat-layer` · 形态：**native cdylib 核心插件**（`tb_probe_rat_layer.dll`）·
> 计算核心：**Rust**（零 vendor，替代原 Python + 130MB 依赖版）。

## 作用

Allegro pin 表（xls/xlsx）+ 筛选文件（.lst/.txt）→ 分层 →
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
pipeline.rs   编排（run_once：分离电源地 → 拥塞 → 冲突检测 → 分层 → 后处理）
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

## 测试

`cargo test -p tb-probe-rat-layer --lib`：pipeline 合成数据 / geometry / config 覆盖 /
扇区索引 / report 往返 / dispatch 命令路由 / **FFI ABI 冒烟**（libloading 直接加载 DLL）。

## 与旧版的关系

原 `plugins/probe-rat-layer`（process Python，130MB vendor，异步任务 + 按需渲染）已改写为
本 native 核心插件；前端 `ui/` 与宿主命令/事件契约**保持不变**。历史与迁移过程见
[docs/改造方案-探针卡分层Rust化.md](../改造方案-探针卡分层Rust化.md)。
