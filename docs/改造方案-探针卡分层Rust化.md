# 探针卡分层插件 Rust 化改造方案

> 状态：**方案**（待用户确认打包形态；第 3 节有一个必须拍板的决策）。
> 目标：把 `plugins/probe-rat-layer` 的计算核心从 Python（含 130MB vendor）改写为
> **Rust 核心库**，尽量复用 crate，显著减小体积，保留现有 Vue 界面与宿主契约。

---

## 0.1 实施进度（2026-09，用户选定方案 A 后）

已按方案 A 落地（`core-plugins/probe-rat-layer/`，cdylib 核心插件）：

- **✅ 算法与输入全移植**：model/config/geometry/keepout/congestion/metrics/layer_stack/
  conflict_classifier/layer_packing/optimizer(SA)/graph_coloring(Dsatur)/post_process/pipeline/
  report（LST/CSV/JSON）/io（calamine 读 xlsx、serde 读 allegro_json、wire_gen MST）/
  viz（plotters→PNG base64）/dispatch（`layer.*` 全命令 + 后台任务/取消/进度/状态恢复）。
- **✅ 编译**：`cargo build -p tb-probe-rat-layer` 通过；**release DLL ≈ 2.49MB**（远小于 130MB vendor，
  落在 2–6MB 目标内）。
- **✅ 单测**：`cargo test -p tb-probe-rat-layer --lib` 7 passed（pipeline 合成数据 24 条分配 /
  geometry 相交 / config 覆盖 / 扇区索引 / report 往返 / dispatch 命令路由伪宿主 /
  **FFI ABI 冒烟**：libloading 直接加载 DLL，验证 tb_abi_version/tb_create/tb_call/tb_destroy）。
- **✅ 整仓**：`cargo check --workspace` 通过；`cargo test --workspace` **69 passed 0 failed**
  （宿主 57 + 本插件 7 + core-example 3 + tb-sdk 2）。
- **✅ clippy**：`cargo clippy --workspace --all-targets --no-deps -- -D warnings` **0 告警**。
- **✅ 前端门禁**：`pnpm lint` 0 告警（76 文件）/ `pnpm build` ✓ / `pnpm test` 40 passed。
- **✅ 部署 + 冒烟**：`pnpm build:core` 部署到 `_core` 自检通过；`pnpm tauri dev` 冒烟——
  应用启动后 native 插件被宿主加载、界面正常、无 `初始化失败`、无崩溃。
  （冒烟暴露并修复：① native 插件在空 vault（未配置工作区）时 `state_from_cfg` 硬报错 →
  放宽为容忍空 vault，与 Python 版一致；② 清理运行时旧外部实例
  `D:\ToolBoxData\plugins\probe-rat-layer` + `plugins.json` 的 `enabled` 移除
  `"probe-rat-layer"`（现为默认启用的核心插件）。）
- **✅ UI**：`plugins/probe-rat-layer/ui` → `core-plugins/probe-rat-layer/ui`（vue 构建产物
  index.js 129KB / gzip 49KB + style.css），build-core 接线完成（PLUGINS 加项 + `dir`/`crate`
  字段 + cargo `-p` 循环）。
- **✅ 外部实例移除**：`plugins/probe-rat-layer` 已移出（其 `test/.pytest_tmp` 因文件系统
  ACL 异常无法删除，整目录 move 到 `target/probe-rat-layer.deleted` 绕过，见 HANDOVER §6.1 坑12）。
- **✅ bundle/脚本更新**：`bundle-external-plugins.mjs` 的 `BUNDLED` 清空（该插件不再是外部
  随包插件）；`.gitignore` 加 `core-plugins/*/ui/index.js/style.css`。
- **✅ 环境阻塞已解除并落地**：
  1. `pnpm build:core` 全流程已跑通（此前因应用锁 DLL + `D:\ToolBoxData` 写入被拒；放宽文件
     策略后成功部署到 `_core`，自检通过）。
  2. 用户机器 `plugins.json`：`enabled` 已移除 `"probe-rat-layer"`；运行时旧外部实例
     `D:\ToolBoxData\plugins\probe-rat-layer` 已删除。
  3. 前端 `pnpm lint / build / test` 已跑通（0 告警 / build ✓ / 40 passed）。
  4. docs（操作手册 / 本方案）已补 native 核心插件说明。

---

## 0. 结论（TL;DR）

- 插件计算核心里的**所有逻辑都是纯数值/几何/启发式计算**，没有任何必须依赖
  Python 的地方（Excel 读取、JSON、二维几何、网格栅格化、扇区轮询、DSATUR、模拟退火、
  报告导出、PNG 渲染，全部有对应的成熟 Rust crate 或 h几十行就能实现）。
- **体积问题根源**：`vendor/` 130.7MB，其中 numpy 栈 ~51MB、matplotlib 栈 ~66MB
  （含 PIL 15.7MB + fontTools 15.6MB）、shapely ~6MB、openpyxl/xlrd ~4MB。Rust 化后
  整个插件（含绘图）**可降到 <10MB**；若走 native cdylib 核心插件，只剩一个 **2–6MB 的 DLL**。
- 界面（`ui/`，Vue 3）与宿主协议（命令/事件/进度轮询/PNG base64 返回）**一行都不用改**
  ——只要 Rust 侧把同样的命令集、同样的 `layer.progress/done/cancelled/failed` 事件、
  同样的返回结构实现一遍。
- 关键决策：三选一（见 §3）。
  - **方案 A（推荐）**：改成 **native cdylib 核心插件**（`core-plugins/probe-rat-layer/`），
    宿主进程内 FFI 加载，体积最小、性能最好，随应用打包。代价：它变成"核心插件"
    （随包分发、默认启用、不可再作为外部插件安装/卸载），id/构建脚本需小改。
  - **方案 B**：仍做 **外部 process 插件**，但 `command` 指向一个编译出的 **Rust 可执行文件**
    （`probe-rat-layer.exe`），计算核心是 Rust 库。保留"可安装/可导出"的外部插件形态。
    代价：需新增 exe 的构建与分发步骤；exe 体积 ~8–15MB；跨平台/二进制入库问题。
  - **方案 C**：native 核心插件 + 保留一个 Rust `bin`（CLI/测试用），两全但工作量最大。

---

## 1. 现状与问题分析

### 1.1 插件作什么

`plugins/probe-rat-layer`（id `probe-rat-layer`，`runtime: process`，`command: ["python","main.py"]`）：
Allegro pin 表（xls/xlsx）+ 筛选文件（.lst/.txt）→ 扇区轮询/贪心/模拟退火分层 → 输出
`layer_N.lst`（供 Allegro 导入）+ report.json + CSV。自带 Vue 前端（`ui/`），
前端经 `api.call` 调 `layer.*` 命令，`api.on` 收 `layer.progress/done/...` 事件。

`main.py`（JSON-RPC over stdio 壳）+ `probe_layer/`（计算包）共：
- 数据结构：`model.py`（Point/Wire/Net/LayerStack/LayerInfo/LayeringResult/ConflictGraph…）
- 算法：`pipeline.py`、`core/{geometry,congestion,conflict_classifier,layer_packing,
  optimizer,graph_coloring,layer_stack,metrics,keepout,post_process}.py`
- 输入：`io/{loader,xlsx_loader,allegro_json,allegro_skill,wire_gen}.py`
- 输出：`report.py`；渲染：`viz.py`（matplotlib→PNG）
- 外壳与状态机：`main.py` 里的 `_run_job` / `_ACTIVE` / `_JOBS` / 命令分发 / 延迟渲染

### 1.2 体积构成（`vendor/` 130.7MB）

| 主体 | 大小 | 用途 |
|---|---|---|
| numpy + numpy.libs | 51.4 MB | 拥塞网格栅格化、候选对向量化 |
| matplotlib + mpl_toolkits | 32.8 MB | 渲染 layer/overview/rose/manual 图 |
| PIL | 15.7 MB | matplotlib 依赖 |
| fontTools | 15.6 MB | matplotlib 字体 |
| shapely + libs | 6.1 MB | 几何（线段相交/距离/rect 圆 buffer） |
| openpyxl + xlrd | ~3.7 MB | 读 xlsx/xls |
| 其余（contourpy/kiwisolver/pyparsing/dateutil/cycler…） | ~3 MB | matplotlib 依赖链 |

**结论**：大头是 numpy + matplotlib 的"数据科学重栈"，而本插件只用到它们的极小子集
（numpy 数组栅格化、一行 `contains_xy`、matplotlib 画线/矩形/圆形/柱状）。换成 Rust 的
`ndarray` + `plotters`，体积直降一个数量级。

### 1.3 为什么能 Rust 化（可行性）

- 算法无 GIL/动态派发需求；数据结构都是普通容器；数值全 f64。
- 唯一"重量级"调用是 shapely 的二维几何与 numpy 的栅格化——都可被纯 Rust 实现精确替换。
- 不存在 python 特有插件（无 C 扩展、无 numpy 独有的 Broadcast 语义在跨层数值上不可替代）。
- 接口契约（JSON-RPC 命令/事件/状态）与宿主解耦，宿主只看 stdout 的 NDJSON，不关心
  后端是 Python 还是 Rust。

---

## 2. 改造目标与验收标准

1. **体积**：插件依赖从 130.7MB → **<10MB**（方案 A 只需一个 2–6MB DLL）。
2. **功能对等**：同一批真实/合成数据，Rust 输出与 Python 一致（层数、各层 net/线、
   硬/软冲突计数、report/CSV/LST 结构），允许浮点/启发式微小差异（非 bit 级）。
3. **UI 不变**：`ui/` 与宿主 `api.call`/`api.on` 契约零改动；进度轮询、PNG base64
   返回、文件动作（init-project-structure / archive-to-batch）、文件浏览全部照常。
4. **可复现**：`sa_seed` 固定时结果可复现（Rust 自洽即可，不强求与 Python 逐位一致）。
5. **验证全绿**：Rust 单测 + 命令行烟测 + `pnpm tauri dev` 冒烟；方案 A 加宿主 e2e。
6. **打包**：随应用分发（方案 A）/ 外部插件可导出（方案 B）在不带 Python 的目标机可跑。

---

## 3. 关键决策：打包形态（必须先拍板）

> 宿主安全模型 **S1b** 强制：`runtime: native` 的插件**只能进核心插件目录 `_core/`**
> （`manager.rs::start_native` 校验 `dir.parent().file_name() == "_core"`，否则拒绝加载）。
> 所以"作为外部插件保持 native"不可行——native 必须做成随包核心插件。

### 对比

| 维度 | A：native cdylib 核心插件 | B：外部 process 插件 + Rust exe |
|---|---|---|
| 形态 | `core-plugins/probe-rat-layer/`，`runtime: native`，`command:["tb_probe_rat_layer.dll"]` | `plugins/probe-rat-layer/`，`runtime: process`，`command:["probe-rat-layer.exe"]` |
| 宿主加载 | 进程内 FFI（最快，~微秒级） | 子进程 + stdio JSON-RPC（~毫秒级） |
| 体积 | DLL 2–6MB | exe 8–15MB |
| 随包/安装 | 随应用打包，**默认启用**，不可再被外部安装/卸载 | 保持"可安装/可导出/可禁用"的外部插件 |
| 改动面 | 移至 core-plugins、加入 workspace、build-core 接线、id 契约微调 | 新增 cargo 构建 exe 并同步进插件目录；`package-plugin`/`bundle:plugins` 需包含 exe |
| 现有外部实例 | 需删除 `plugins/probe-rat-layer` 目录并迁移 enabled 列表 | 基本保留，仅换 command 二进制 |
| 测试 | Rust 单测（同 `core-plugins/example`）+ 宿主 e2e；`protocol_test.py` 不再适用 | `protocol_test.py` 基本保留（改 spawn exe） |
| 线程生命周期 | 需在 `tb_destroy` 前 join 后台线程（见 §6.3，避免 use-after-free） | 进程退出即结束，无此问题 |
| 崩溃隔离 | 仅 `catch_unwind`；宿主不自动重启（挂死需 cancel） | 宿主自动重启（限次） |

### 推荐

**方案 A**，理由：最贴合"改成 Rust 核心库"、体积最小、性能最好、不用另造二进制分发管线
（与 core-example 一致，`build:core` 直接产出并随包）。B 作为"必须保持外部/可安装插件"
时的备选。推荐直接做 A；若用户明确要"仍然是一个外部可安装插件"，则改 B。

---

## 4. Rust 依赖（crate）选型

| Python | Rust crate | 说明 |
|---|---|---|
| `openpyxl`/`xlrd` 读 xlsx/xls | **[calamine](https://github.com/milanjovanovic/calamine)** | 纯 Rust，读 xls/xlsx/xlsb/ods；比 openpyxl+xlrd 更轻 | 
| JSON 读写（config/report/geometry/result） | `serde` + `serde_json` | 已有（宿主/插件均用） |
| `shapely` 几何 | **自写 `geometry` 模块**（约 200 行）或 [`geo`](https://docs.rs/geo) | 本插件只用线段相交/线段距离/点段距离/rect 圆包含——二维基础运算，自写可**逐位对齐** Python，避免库语义漂移；`geo` 更省事但结果可能略不同 |
| `numpy` 栅格化/向量化 | [`ndarray`](https://docs.rs/ndarray) 或 `Vec<Vec<f64>>` | 拥塞网格、候选对，索引/栅格化逐格实现（模拟 numpy 语义） |
| `matplotlib` 画 lin去/矩形/圆形/柱状 + PNG | [`plotters`](https://docs.rs/plotters) | 纯 Rust 位图+图表；含 `image` 后端，输出 PNG；`plotters` 0.3 已去掉 polar 投影，rose 图用"极角→笛卡尔多边形"画 |
| 渲染 PNG 编码（若直接画） | `image` + `png`（或 `tiny-skia`） | plotters 已带；如需更小可换 `tiny-skia` 软件光栅 + `png` 编码 |
| Python `random.Random(seed)` | `rand` + `rand_pcg`（Pcg64）或 [`rand_mt`](https://docs.rs/rand_mt)（MT19937） | 只需自洽可复现；若要与 Python **逐位一致**改用 rand_mt（或自实现 mt19937） |
| `datetime` | `chrono` | job_id `%Y%m%d_%H%M%S`、report `generated_at` |
| `csv` | `csv` | 导出 net_layer_assignment.csv / layer_statistics.csv |
| JSON-RPC over stdio（方案 B） | 手写：`serde_json` + `BufRead` 循环 | 协议简单（NDJSON），不必引 `jsonrpsee`（过重） |
| 文件操作 | `std::fs` | — |
| 日志 | `tb_sdk::log`（native）/ stderr（process） | — |

> 版本/可维护性提示：`calamine`、`plotters`、`ndarray`、`geo`、`rand`/`rand_mt` 均为
> 活跃纯 Rust 项目；`plotters` 是 2D 绘图事实标准（无 polar 时需手工极坐标）。

### 关于"尽量搜索使用 rust 库"的结论

- 现成覆盖：**Excel 读取=calamine、JSON=serde_json、绘图=plotters、数组=ndarray、
  随机=rand*(MT 可选)、时间=chrono、CSV=csv**。
- **没有**一个现成的"探针卡飞线分层"开源 Rust 库（这属于很垂直的业务算法），
  核心分层算法（扇区轮询 + 冲突消除 + 模拟退火）必须**自己移植**——但都是纯确定性代码，
  迁移工作量主要在这部分。
- 几何库 `geo` 可省，但为了**与 Python 行为一致**建议自写最小几何模块。

---

## 5. 模块映射（Python → Rust）

| Python | Rust | 备注 |
|---|---|---|
| `model.py` | `model.rs` | `Point/Wire/Net/Pin/LayerDef/LayerStack/SignalGroup/NetGroup/LayerInfo/LayeringResult/Conflict/ConflictGraph`，全 struct + `f64` |
| `config.py` | `config.rs` | `LayeringConfig`，`#[derive(Deserialize)]` + `default()/to_json()`；未知字段忽略用 `#[serde(deny_unknown_fields)]` 否→手动过滤 |
| `core/geometry.py` | `geometry.rs`（自写） | 线段严格相交、线段最小距离、点段距、线段-rect/圆相交、矩形/圆包含、bbox |
| `core/keepout.py` | `keepout.rs` | 加载 zones、穿越计算、shared-zone、pinch 检测 |
| `core/congestion.py` | `congestion.rs` | 网格几何 + 栅格化（`ndarray`）+ supply/demand/occupancy；`contains_xy`→点 in rect/圆 |
| `core/conflict_classifier.py` | `conflict_classifier.rs` | bbox 扫描线候选对 + `classify_pair`（直线相交/近距/拥塞/禁布区/端点），产 `Conflict`+`ConflictGraph` |
| `core/layer_packing.py` | `layer_packing.rs` | MFPS 排序 + 方向感知贪婪铺层（`preferred_dir`）→ `_resolve_conflicts`（边驱动）+ `_balance_lengths` + `_enforce_capacity`（增量网格）+ `minimize_crossings` + `capacity_lower_bound` |
| `core/optimizer.py` | `optimizer.rs` | 模拟退火（swap/move、Metropolis、护栏、`sa_seed`、降温；`hard_conflict_in` 邻接表化 O(deg)） |
| `core/graph_coloring.py` | `graph_coloring.rs` | DSATUR（受限着色、`UncolorableError`） |
| `core/layer_stack.py` | `layer_stack.rs` | 允许层、split_trace_plane、group 归类 |
| `core/metrics.py` | `metrics.rs` | `sector_index/soft_crossings/count_imbalance/length_imbalance/sector_imbalance` |
| `core/post_process.py` | `post_process.rs` | `verify_hard_free/soft_conflicts_per_layer/collect_layer_marks/max_occupancy_per_layer` |
| `io/xlsx_loader.py` | `io/xlsx.rs` + `calamine` | 列别名字典、`classify_net`、白名单、`generate_wires` |
| `io/allegro_json.py` | `io/allegro_json.rs` | serde 解析 nets/stack/groups/zones/wires 双模式 |
| `io/wire_gen.py` | `io/wire_gen.rs` | 2-pin 单线 / 3-pin share / ≥4-pin Prim MST |
| `io/loader.py`/`allegro_skill.py` | 并入 `io.rs` | `LoadedData`、Skill 脚本占位/feedback 解析 |
| `pipeline.py` | `pipeline.rs` | `run_once`/`run`，进度回调 + `check_cancel` |
| `report.py` | `report.rs` | build_report/各 export/*.lst/*.csv/write_report |
| `viz.py` | `viz.rs` + `plotters` | render_layer/overview/rose/manual → PNG base64 |
| `main.py` 外壳 | `dispatch.rs` + `LayerState`（native）或 `main.rs`（process exe） | 见 §6 |

---

## 6. 关键实现要点

### 6.1 命令集与协议对等（UI 零改动的关键）

必须交付**完全一样**的命令与返回结构：

```
init（native 不需要握手；process exe 需要返回 {"commands":[...]}）
layer.listDir / layer.config / layer.run / layer.status / layer.cancel /
layer.result / layer.readOut / layer.render / layer.openOut /
layer.report / layer.notifyDone / plugin.action
事件：layer.progress {jobId,stage,percent,message} /
     layer.done {jobId,summary} / layer.cancelled {jobId} / layer.failed {jobId,error}
```

- `layer.status` 返回的字段（含 **camelCase `jobId`**，别用 snake_case——2026-09 已踩坑，
  前端认 `jobId`）。
- `layer.render` 返回：完整 PNG → **base64 data URL 字符串**；未命中 → `{"pending":true}`
  （幂等后台渲染）；失败 → 抛错（写 `.failed` 标记）。UI 轮询本命令直到拿到字符串。
- `layer.run` 秒回 `{"jobId":...}`，后台线程跑；`run` 期间若有任务在跑 → 报错"已有任务在运行"。

### 6.2 后台任务模型（native 尤其需要）

- `LayerState` 持有当前 job（`job_id/state/stage/percent/message/error` + `Arc<Mutex<...>>`），
  `layer.run` 置 running、spawn `std::thread` 跑 `pipeline::run`，立即返回。
- 进度：后台线程更新 `LayerState`.`percent/message`，并 `tb_sdk::emit(host,ctx,"layer.progress",…)`
  （native）/ stdout 写 `layer.progress`（process）。
- 取消：`Arc<AtomicBool>` 取消标志；把 Python 的 `check_cancel` 移植成 `cancel()`（在各热循环
  里周期性检查）。`layer.cancel` 置位。
- 状态机沿用 `idle|running|done|failed|cancelled`；`_restore_jobs`（进程重启恢复）在
  native 下改为"插件实例重建时从 `config_dir/jobs/<id>/meta.json` 扫描恢复 done 任务"。

### 6.3 ⚠️ native 线程生命周期（必须处理，否则 use-after-free）

`tb_sdk` 文档明确：`emit`/`log` 的 `ctx`（`host.ctx`）在 `tb_destroy` 后失效，**后台线程
不能跨实例销毁使用**。Python 用 daemon 线程（进程退出即清），native 不行——DLL 卸载后
线程代码已不在。

对策：
- 后台线程持有**加入实例状态**的 `JoinHandle`；`LayerState` 实现 `Drop`：置取消标志 →
  **join（带有限等待）所有后台线程**，确保 `tb_destroy` 返回前线程已终止（DLL 安全卸载）。
- 因为分层 ~25s，`tb_destroy` 时若正跑，join 会阻塞宿主 UI。缓解：取消标志在所有热循环里
  高频检查（SA 每步、栅格化批次、扇区轮询各阶段），取消后通常 0.1–2s 内可 join；
  若确实需立即返回，可在 Drop 里 join 前先确认线程即将结束（风险窗口很小，且仅发生在
  中途禁用/重载插件，属异常路径）。
- 渲染后台线程只写 PNG 文件 + 更新状态，**不 emit 事件**（避免 ctx 使用），因此更安全。

### 6.4 渲染（plotters → PNG base64）

- `plotters` `BitmapBackend` 输出 `image`/`png`；读回字节 → base64 → `data:image/png;base64,...`。
- layer/overview：`LineSeries` 批量画线；keepout 用 `Rectangle`/`Circle`（或 `PathElement`）；
  交点标记用小圆/叉。
- rose（极坐标柱状）：plotters 0.3 无 polar——把每扇区柱换算成极坐标多边形
  （`x=r·cosθ, y=r·sinθ`），用 `PathElement`/`PolygonElement` 画在笛卡尔图，或直接改画
  笛卡尔柱状（theta 做 x 轴）。建议保留极坐标观感（多边形）。
- PNG 完整性：保留 Python 的 `_png_ready`（尾 `\x00\x00\x00\x00IEND\xaeB\x60\x82`）判断，
  避免轮询读到"已创建未写完"的半成品。

### 6.5 文件 / 路径 / 配置

- **工作区**：native 由 `start_native` 注入 cfg `{"vault":..., "config_dir":...}`；
  插件用 `state.vault`（当前工作区），与 Python 的 `TB_WORKSPACE` 等价。process exe 由宿主
  env `TB_WORKSPACE` 注入。文件动作的 `_safe_join` 越界防护用 `tb_sdk::resolve_safe`（native）
  / 自己实现（process）。
- **jobs/cache/settings 存放**：native 建议放 `cfg.config_dir`（如
  `%APPDATA%/com.toolbox.desktop/`）下，而不是 `_core/<id>/` 内——避免把运行时数据写进
  插件安装目录（更新时 `ensure_core_plugins` 覆盖管理该目录）。Python 版放插件目录，native
  换到 `config_dir` 更干净。process exe 版仍放插件目录（与现状一致）。
- **out_dir** 由前端传入（用户在文件视图选），插件直接写。

### 6.6 数值一致性注意

- `numpy` 栅格化 → `ndarray`：用 `HashSet<(usize,usize)>` 去重格点（对应 `np.unique`），
  逐格累加 demand，避免浮点累计顺序带来的差异。
- 直线相交判定：Python 用 `shapely` 的 `intersection`（`is_empty`/`geom_type=="Point"`）；
  自写段-段相交用叉积/方向测试并处理重合/端点，确保与 Python 阈值（`EPS=1e-9`）一致。
- 模拟退火：`random` 序列用 `rand_pcg::Pcg64`（或 `rand_mt`）以 `sa_seed` 种子；`sa_max_steps`
  默认 `max(4000, 30*len)`；`progress_every = steps/50`。
- 保持 f64，输出 `round(x,6)`/`round(x,4)` 与 Python `round`（银行家舍入差异可接受，用文档说明）。

### 6.7 算法效率与质量改进（方案 B，2026-09）

在保留"打包（packing）主方法 + 模拟退火精修"语义的前提下，专项优化了瓶颈与初值：

- **瓶颈定位**：旧 `pack_layers` 里 `_resolve_conflicts` 逐轮**两两扫描单元** O(n²)、
  `_enforce_capacity` 每候选层**整栅格 clone + 全量 `max` 扫描**、SA 每步 `hard_conflict_in`
  **遍历整层 wires**——三者是 1800 网 / 73.6s 的主要来源。
- **改进**：
  1. **MFPS 排序 + 方向感知贪婪初值**：按"最难优先"（硬冲突度降序→线长降序）排单元，
     逐单元放到"方向匹配（`LayerStack.preferred_dir` 的 H/V）→ 当前负载最小"的允许层。
  2. **边驱动 `_resolve_conflicts`**：从硬冲突图边构建"同层不同单元"坏单元集，就近挪到
     无冲突允许层；复杂度 O(边数+坏单元×邻接度)。
  3. **增量 `_enforce_capacity`**：移动判定只在单元覆盖格点算占用量，提交时增量更新栅格。
  4. **SA `hard_conflict_in` 邻接表化**：O(层线数)→O(deg)。
- **实测**（`hv` 预设，1800 网，release）：

  | 指标 | 旧版（应用） | 方案 B |
  |---|---|---|
  | 耗时（release）| 73.6s | **1.74s**（~42×）|
  | 已分配线 | 1781 | 1798 |
  | 硬冲突 | 272 | 272 |
  | 软冲突（总）| 23818 | 23818 |
  | 需人工 route | 19 | 2 |

  质量持平或更优（同层软冲突、占用率均衡度相近），性能大幅提升。复测：
  `cargo test --release -p tb-probe-rat-layer -- --ignored --nocapture`（需真实数据路径）。

---

## 7. 打包与构建接线（按方案 A 的详细步骤）

### 7.1 仓库结构

```
core-plugins/probe-rat-layer/
  Cargo.toml            # package=tb-probe-rat-layer, [lib] name=tb_probe_rat_layer, crate-type=["cdylib"]
  src/
    lib.rs              # tb_plugin!(LayerState, state_from_cfg, call)
    model.rs config.rs pipeline.rs report.rs dispatch.rs
    geometry.rs keepout.rs congestion.rs conflict_classifier.rs
    layer_packing.rs optimizer.rs graph_coloring.rs layer_stack.rs metrics.rs post_process.rs
    io/{mod.rs,xlsx.rs,allegro_json.rs,wire_gen.rs}
    viz.rs
  ui/                   # 把现有 plugins/probe-rat-layer/ui 原样搬过来（Vue），无需改动
    index.ts App.vue bridge.ts style.css
  plugin.json           # runtime:native, command:["tb_probe_rat_layer.dll"], ui/nav/actions 照搬
  README.md test/（Rust 集成测试）
```

### 7.2 改动清单

| 位置 | 改动 |
|---|---|
| `Cargo.toml` [workspace] members | 加 `"core-plugins/probe-rat-layer"` |
| `scripts/build-core.mjs` | PLUGINS 数组加一项：`{id:"probe-rat-layer", dir:"probe-rat-layer", dll:"tb_probe_rat_layer.dll", ...}`；`buildCorePluginUi` 用 `p.dir ?? p.id.slice(5)`；cargo build 命令加 `-p tb-probe-rat-layer` |
| `scripts/bundle-external-plugins.mjs` | `BUNDLED` 移除 `"probe-rat-layer"`（它不再是外部插件） |
| 宿主 `src-tauri/.../manifest.rs` / manager | 无需改（native 逻辑已支持） |
| `plugins/probe-rat-layer/` | **删除**（外部实例）；同步删运行时 `D:\ToolBoxData\plugins\probe-rat-layer` |
| 运行时 `plugins.json` | `enabled` 从 `["probe-rat-layer"]` 更新（核心插件默认启用；如需禁用记 disabled） |
| `ui/index.ts` mount 键 | 若 id 变 `core-probe-rat-layer` 需同步；**保持 id=`probe-rat-layer` 则不变** |
| `docs/插件开发指南.md`/`操作手册.md`/`README.md`/`PLAN.md` | 示例清单/依赖方案章节更新 |

> 说明：native 核心插件**默认启用**（`is_native → 不在 disabled 即启用`，见 manager.rs），
> 与外部插件"默认不启用"不同。你当前的启用状态将自动延续（核心插件默认启用），如需
> 默认关闭需列入 `ensure_initial_state` 的 disabled。

### 7.3 分发

`pnpm build:core:release` 产出 DLL + `ui/*.js` → `src-tauri/resources/_core/probe-rat-layer/`，
`bundle.resources` 已带 `_core`，随安装包分发；首启 `ensure_core_plugins` 部署到应用配置目录
`plugins/_core/`。无 Python、无 vendor。

---

## 8. 测试与验证

| 层 | 做法 |
|---|---|
| Rust 单测 | 各模块纯函数单测（geometry/congestion/metrics/layer_packing/optimizer/model），如 `core-plugins/example` 的 `#[cfg(test)]` |
| 协议对等测试 | 用 Rust 写一个"伪宿主"驱动 `call` 分发器跑完整命令序列（init→run→status→result→render→…），断言返回结构与 Python `protocol_test.py` 一致（可复用 `target/mock-host.py` 的用例脚本化） |
| 数值对照 | 用 `plugins/probe-rat-layer/test/protocol_test.py` 生成同样的合成数据，比较 Rust/Python 的分层摘要（层数/各层 net/冲突数）——保留一份对照脚本（跑 Rust exe 或作为参考值） |
| 真实数据回归 | `in/1.xlsx + hv_all.lst`（1800 线）跑一遍：run 秒回、25s 内完成、层数/冲突计数与 Python 对照 |
| 前端 | `pnpm tauri dev` 冒烟：界面加载、进度条、结果页、PNG 显示、取消、文件动作 |
| 门禁 | `cargo test --workspace` / `cargo clippy --workspace --all-targets --no-deps -- -D warnings` / `pnpm lint && build && test` 全绿才 push |

> 方案 A 注意：`protocol_test.py` 的 spawn 逻辑不再适用（没有 `python main.py` 子进程），
> 改由"伪宿主调用 dispatch"的 Rust 集成测试替代；Python 侧保留一份"参考实现/对照值"。

---

## 9. 迁移与上线（避免新旧并存冲突）

1. 删除 `plugins/probe-rat-layer/`（外部实例）、`D:\ToolBoxData\plugins\probe-rat-layer`。
2. 运行时 `plugins.json`：更新 enabled/disabled 列表（核心插件 `probe-rat-layer` 默认启用）。
3. `bundle:plugins` 的 BUNDLED 移除该插件。若曾打包进旧版本，目标机 `_core` 旧残留由
   `ensure_core_plugins`/`build:core` 的清理逻辑处理（`removed_bundled`/`removed_core` 语义）。
4. 用户已生成的历史任务/结果（jobs/、out/）若在旧外置目录，可手工拷贝或直接重新跑一遍。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 启发式结果与 Python 略有差异 | 记"非 bit 级一致"为验收标准；保留 Python 作对照；数值核心逐字段对照 |
| native 后台线程 use-after-free | §6.3 的 Drop+join+cancel；渲染线程不 emit |
| 重载/禁用时 join 卡 25s | 热循环高频 cancel 检查；只发生在异常路径；可加 bounded join 超时后 disown（需保证 DLL 不卸载——用 `std::mem::forget` 保 DLL？不可取；用确保线程快速终止的充分取消即可） |
| `p.id.slice(5)` 假设 | build-core 改为 `p.dir ?? p.id.slice(5)` |
| 绘图体积 | plotters 已比 matplotlib 小；如需更小可换 `tiny-skia`+`png` 或前端渲染 |
| rose 极坐标 | plotters 0.3 无 polar → 手工极坐标多边形 |
| 32 位/跨平台 | 目标是 Windows x64（宿主如此）；process exe 需按平台构建 |

---

## 11. 分阶段实施计划（里程碑建议）

- **M0 决策**：确认 §3 打包形态（A 默认 / B 备选）。
- **M1 骨架**：`core-plugins/probe-rat-layer/` crate + `tb_plugin!` 空壳 + `model/config`
  + workspace/build-core 接线跑通（DLL 能被宿主加载、命令返回空）。
- **M2 算法移植**：geometry → congestion → conflict_classifier → layer_packing →
  optimizer → graph_coloring → pipeline → report；每个模块带单测并对照 Python。
- **M3 输入输出**：calamine 读 xlsx / serde 读 allegro_json / wire_gen；产出 report/LST/CSV。
- **M4 连接**：`dispatch.rs` 命令集 + 后台任务/取消 + 进度事件；`layer.render`（plotters→PNG）。
- **M5 UI/接线/收尾**：搬 `ui/`、删外部实例、迁移 plugins.json、文档同步、`pnpm tauri dev` 冒烟 + 打包冒烟。
- **M6 验证**：cargo/clippy/前端门禁全绿 + 真实数据回归 + （可选）发布。

---

## 附：体积预估对比

| 形态 | 依赖/资源 | 体积 |
|---|---|---|
| 现状（Python+matplotlib stack） | vendor/ | **130.7 MB** |
| A：native DLL | tb_probe_rat_layer.dll（strip+thin LTO） | **2–6 MB** |
| B：process exe | probe-rat-layer.exe | **8–15 MB** |
| B（去 matplotlib，改用 tiny-skia/前端渲染） | exe | ~5–10 MB |

*（编译体积取决于依赖特性与 `profile.release` 的 strip/lto；workspace 已设 `strip=true, lto="thin"`。）*
