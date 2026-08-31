# 探针卡分层插件 `probe-rat-layer`

把原项目 [Rat-layer](https://github.com/backunderstar/Rat-layer)（`probe_layer`，探针卡飞线分层工具）
包装为 ToolBox process 插件：**Python 进程（JSON-RPC over stdio）+ 自带 Vue 界面**，
侧边栏「探针卡分层」进入，图形化完成「选文件 → 配参数 → 分层 → 看结果图」，全程不启动原 CLI。

- 分层算法 = 原项目原样（扇区轮询 → 贪心交叉最小化 → 模拟退火精修 → 人工兜底），
  仅加了**进度回调 + 取消钩子**（可选参数，不改变原行为）。
- 输出与 CLI 完全一致：`out_*/` 下 `lst/`（Allegro 导入）、`csv/`、`json/`、`img/`。

---

## 1. 安装 / 构建

插件目录 = 插件 id（`probe-rat-layer`）。仓库内开发 + 应用内部署：

```powershell
# 1. 装 Python 依赖到 vendor/（方案 A vendored，不入库；等同插件页「安装依赖」按钮）
#    用宿主捆绑 Python（与目标机一致，cp314 wheel）：
& "$env:APPDATA\com.toolbox.desktop\python\python.exe" -m pip install --target vendor -r requirements.txt

# 2. 构建前端（ui/index.ts → ui/index.js + style.css，gitignored，不入库）
pnpm build-external-ui plugins/probe-rat-layer

# 3. 同步到应用插件目录（保留 vendor；应用运行时目录被锁会 EPERM，先关应用或跳过）
pnpm sync:plugins
```

应用内「插件」页确认 `probe-rat-layer` 已启用；process 插件进程常驻，改 `main.py` 后点「重新加载」。

**随安装包分发（2026-09 release 起）**：`pnpm bundle:plugins` 会把本插件（含 vendor 离线依赖、
production 构建的 ui）复制进 `src-tauri/resources/bundled-plugins/probe-rat-layer/`，随 ToolBox
安装包分发；首启由宿主部署到全局插件目录。**随包插件默认关闭**——装完 ToolBox 后在插件页手动
启用一次；升级 ToolBox 时随包版本会覆盖部署（插件内运行产物 cache/jobs 在构建期已排除，但
插件目录里用户自己的改动会被覆盖，有定制需求请复制到别的目录再改）。

依赖（`requirements.txt`）：`shapely numpy matplotlib openpyxl xlrd`。目标机无需装 Python：
宿主三级解析解释器（插件自带 python.exe → 全局捆绑 `%APPDATA%\com.toolbox.desktop\python\` → 系统 PATH）。

---

## 2. 界面（四个页签）

| 页签 | 内容 |
|---|---|
| **输入设置** | 输入 1：Allegro pin 表（.xls/.xlsx，兼容旧 JSON）；输入 2：筛选文件（可选，.lst/.txt 一行一个 net，兼容 .xls/.xlsx 第一列）；**输出目录（必填，强制指定）**；预设（**默认 DC 信号** / 全量 / 自定义）；层数/线宽/线距。内置文件浏览器（盘符→目录→文件） |
| **分层参数** | 方法（packing/dsatur）、优化器（sa/greedy/none）、迭代①-④轮数、SA 参数、拥塞参数；未列字段用 `probe_layer` 默认值 |
| **运行** | 「开始分层」秒回（后台线程），进度条 + 阶段文案 + 事件流，可取消；自定义参数且阈值 <1.5 时提示 DC 信号预设 |
| **结果** | 摘要卡（层数/线数/硬软冲突/人工清单/耗时）、各层统计表（点击行→**按需渲染 PNG 图**，另有总览图/玫瑰图）、「查看 report.json」、.lst/CSV 查看与复制、「打开输出目录」；**人工线占比 >30% 时醒目提示并一键应用 DC 信号预设** |

> ⚠️ **默认预设 = DC 信号（cell 2.0 / threshold 3.0）**：原项目文档明确默认 0.8/0.5 对 DC/HV 信号太严
> （实测 1800 线 DC 信号全量用默认参数会 manual 1758 条；DC 信号预设 manual 仅 18 条）。
> 首次打开与「自定义」手调后都建议确认预设；参数与预设会持久化到 `settings.json` 下次恢复。

### 参数速查（界面每个字段下方也有小字解释）

| 分组 | 字段 | 说明 |
|---|---|---|
| 分层方法 | `method` | packing（扇区轮询，默认）/ dsatur（图着色基线，A/B 用） |
| | `sector_angle_deg` | 扇区角（45°=8 扇区；越小扇区越多、层间越均匀） |
| 迭代 | `resolve_conflict_rounds` | 同层硬冲突微调轮数（越大越少冲突、越慢） |
| | `balance_length_rounds` | 各层线长均衡交换轮数 |
| | `minimize_crossings_passes` | 贪心最小化软冲突轮数（每轮扫全部软冲突对） |
| | `sa_restarts` | SA 多起点次数（>1 耗时 ×N，结果更稳） |
| 精修 | `optimizer` | sa（模拟退火，默认）/ greedy（只贪心）/ none（关精修） |
| | `sa_initial_temp` | 退火初始温度（越高探索越广） |
| | `sa_cooling` | 每步降温系数（越接近 1 越慢越充分） |
| | `sa_max_steps` | 步数（0=自动 max(4000, 30×线数)） |
| | `sa_swap_ratio` | 交换移动占比（其余为单线移动） |
| | `sa_balance_slack` | 均衡护栏：允许恶化到初始值的倍数 |
| 拥塞 | `congestion_grid_cell` | 拥塞网格边长 mm（HV 用 2.0；越小判得越细） |
| | `congestion_hard_threshold` | 交点拥塞超此值判硬冲突（HV 用 3.0；越大层越少、人工线越多） |
| | `layer_capacity` | 每层 occupancy 上限（勿 >1） |
| | `capacity_utilization` | 目标容量利用率（越小越保守、层数越多） |
| | `via_area_cost` | 过孔占用面积折算成本（越大越避免过孔密集区） |
| 输入 | `layers` | 信号层数（xlsx 输入；旧 JSON 由文件决定） |
| | `width` | 线宽 mm（HV/DC 0.2，AC 0.1） |
| | `clearance` | 线距 mm |

未列出的字段（`sa_seed`、`same_net_same_layer`、`pin_density_weight` 等）用 `probe_layer` 默认值，
可经 `layer.run` 的 `config` 覆盖（见 §3）。

---

## 3. 命令白名单（init 握手声明）

| 命令 | 参数 → 返回 | 说明 |
|---|---|---|
| `layer.listDir` | `{path?}` → `[{name,isDir,size}]` | 内置文件浏览器；path 空 = 盘符列表 |
| `layer.config` | `get` / `set {patch}` | 插件设置，存 `<插件>/settings.json`（恢复上次输入） |
| `layer.run` | `{input, filter?, outDir, layers?, width?, clearance?, config?, resolve_conflict_rounds?...}` → `{jobId}` | **秒回**；后台线程跑分层+导出 |
| `layer.status` | → `{state, jobId?, stage?, percent?, message?, error?}` | idle/running/done/failed/cancelled；UI 轮询驱动进度 |
| `layer.cancel` | → `{ok}` | 置取消事件，SA/打包循环内检查，干净退出 |
| `layer.result` | `{jobId}` → `{summary, layers, outDir, files}` | 摘要几 KB（不进 30s 超时） |
| `layer.report` | `{jobId}` → `{text}` | report.json 原文预览（冲突明细截断到每级前 300 条） |
| `layer.readOut` | `{jobId, rel}` → 文本 | 输出目录内相对路径读取（限 4MB，防穿越） |
| `layer.render` | `{jobId, kind}` → PNG base64 data URL（未命中 `{"pending":true}`） | 按需渲染 `layer_<i>` / `overview` / `rose` / `manual`（matplotlib 懒加载 + 后台线程 + 磁盘缓存） |
| `layer.openOut` | `{outDir}` → `{ok}` | 资源管理器打开输出目录（核心 API `shell.exec`） |
| `layer.notifyDone` | `{title, body}` → `{ok}` | 完成横幅（核心 API `notify`；后台线程不能调核心 API，故由 UI 触发） |

事件（Notification）：`layer.progress {jobId, stage, percent, message}`、`layer.done`、`layer.failed`、`layer.cancelled`。

### 异步任务模型（为什么这么设计，勿改）

宿主对 process 插件单次 call 有 **30s 硬超时**（`manager.rs API_TIMEOUT`），而 HV 真实数据分层
~25s、全量数据更长 → 分层必须在**后台线程**跑，`layer.run` 立即返回，进度靠**轮询 `layer.status`**。
宿主读线程（`process.rs read_loop`）持续解析 stdout，但**事件只在 call 在途时**转发到前端
（`call_raw` 循环内），空闲期事件在通道积压 → 所以 `layer.progress` 通知照发（轮询期间顺带到达），
但 UI 进度条以 `layer.status` 轮询为准，不依赖事件到达时机。

后台线程**不能调用核心 API**（宿主只在 call 期间响应核心请求）→ 本插件写输出文件一律用
Python 直接 `open()`（插件是真实 OS 进程，任意路径可读写），不需要 `fs:*` 权限。

---

## 4. 输出文件（与 CLI 一致）

```
out_<outDir>/
├── lst/layer_1.lst ~ layer_N.lst   # ★ Allegro 导入：每层一行一个 net
├── lst/manual_route.lst            # 自动分不开、需人工 route 的 net
├── csv/net_layer_assignment.csv    # net → 层 对照表
├── csv/layer_statistics.csv        # 每层 net 数/线数/软冲突/占用率
├── json/report.json                # 完整结果（含冲突明细，可能 >4MB）
├── json/layer_nets.json            # 层 → net 清单
└── img/                            # 由 layer.render 按需生成到 <插件>/jobs/<jobId>/img/
```

运行元数据（几何/结果精简数据、渲染缓存）存 `<插件>/jobs/<jobId>/`（不入库、可删）。

---

## 5. 独立测试（不启动 ToolBox）

```powershell
# A. vendored 包单元测试（需 pytest + 依赖的开发环境，如原项目 uv venv）：
#    在插件目录下直接跑（pytest.ini 已配置 testpaths/norecursedirs，31 passed）。
#    注意：vendor/ 是宿主捆绑 Python（cp314）装的 wheel，别用 PYTHONPATH=vendor
#    去喂别的解释器（ABI 不匹配，shapely.lib 等扩展模块会 ImportError）。
python -m pytest -q

# B. 协议全链路测试（生成合成 pin 表，不依赖真实数据；--python 用捆绑解释器
#    即验证"目标机场景"：main.py 启动时自动把 vendor 插进 sys.path）：
python test/protocol_test.py --python <含依赖的解释器>

# C. 用模板 mock-host 的异步模式（--wait-done 验证后台任务事件）：
python <ToolBox>/templates/external-plugin/test/mock-host.py . `
    --python <解释器> --call layer.run `
    --args '{\"input\":\"D:/in.xlsx\",\"filter\":\"D:/filter.lst\",\"outDir\":\"D:/out\",\"layers\":4}' `
    --wait-done --wait-timeout 90
```

宿主内最终验证：`pnpm build-external-ui` + `pnpm sync:plugins` + 插件页「重新加载」→
真实数据 `in/1.xlsx + in/hv_all.lst` 跑一遍（实测 1800 线 ~25s，soft 23818 / manual 18）。

---

## 6. 安全与边界说明

- **任意路径读写**：本插件处理任意 CAD 文件，Python 直接读/写绝对路径（绕过宿主核心 API 的
  vault 限制——权限模型只拦核心 API 通道，拦不住插件自身行为，见插件开发指南 §0.4）。
  首方插件 + 本说明明示；`layer.readOut` 有防穿越校验（只读输出目录内）。
- 权限仅声明 `log / notify / shell`（`shell` 用于 explorer 打开输出目录）。
- **已知限制**：渲染图不含冲突标记（v1 只做各层汇总 + report.json 原文）；取消在
  SA/打包循环边界生效（最迟 ≤2% 步数）；**进程重启后恢复上次完成的任务**（`jobs/<id>/meta.json`
  持久化摘要，`_restore_jobs` 启动时扫描），但正在运行中的任务重启后丢失（UI 自动回 idle）。

## 7. 与原项目同步（副本维护）

`probe_layer/` 是从 Rat-layer 仓库**拷贝**的副本（+ `cancel.py` + 三处可选钩子参数）。
原项目改动后按此同步：重拷 `probe_layer/` 与 `test/probe_tests/` → 重新加钩子
（`pipeline.run_once/run` 的 `on_progress/cancel_event`、`layer_packing` 的
`on_progress/cancel_event`、`optimizer.optimize_layering` 的 `on_progress/cancel_event`）
→ 重打 **viz.py 本地改版**（插件只输出 PNG 不输出 SVG：SVG 大图 DOM 在宿主 WebView2
光栅化慢，见 viz.py 头注释；CLI 侧 `render_svg` 已改名 `render_png`）
→ `pnpm build-external-ui` → 重跑 §5 测试。**保持 `pipeline.run(data, cfg)` 等接口不动**，
插件壳只面向这三个面。
