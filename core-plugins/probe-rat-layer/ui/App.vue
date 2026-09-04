<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type {
  PluginBridgeApi, DirEntry, Status, JobResult, ProgressData, DoneData,
} from "./bridge";

/**
 * 探针卡分层插件界面（四个页签：输入设置 / 分层参数 / 运行 / 结果）。
 *
 * 与 Python 子进程的通信全部经 api.call（JSON-RPC over stdio）：
 * - layer.run 秒回 {jobId}，分层在后台线程跑（宿主单次 call 有 30s 硬超时，
 *   必须异步；进度以轮询 layer.status 为准，layer.progress 事件为实时补充）；
 * - 输出目录强制用户指定（拍板决定）；
 * - 图片用 layer.render 按需渲染（matplotlib 懒加载），返回 PNG data URL 直显。
 * 样式只引用宿主设计令牌（tokens.css 变量），类名前缀 prl- 避免污染宿主。
 */
const props = defineProps<{ api: PluginBridgeApi }>();

/* ---------- 页签 ---------- */
const tabs = [
  { id: "input", label: "输入设置" },
  { id: "params", label: "分层参数" },
  { id: "run", label: "运行" },
  { id: "result", label: "结果" },
] as const;
const activeTab = ref<(typeof tabs)[number]["id"]>("input");

/* ---------- 首次配置向导 ---------- */
/** 是否已完成路径配置（settings.json 的 configured；未配置 → 显示配置向导而非页签） */
const configured = ref(false);

/* ---------- 输入设置 ---------- */
const inputPath = ref("");
const filterPath = ref("");
const outDir = ref("");
const layers = ref(4);
const width = ref(0.2);
const clearance = ref(0.2);
const inputError = ref<string | null>(null);

/* ---------- 分层参数（默认值 = probe_layer/config.py） ---------- */
const method = ref("packing"); // packing | dsatur
const optimizer = ref("sa"); // sa | greedy | none
const resolveConflictRounds = ref(12);
const balanceLengthRounds = ref(6);
const minimizeCrossingsPasses = ref(6);
const saRestarts = ref(2);
const saInitialTemp = ref(8.0);
const saCooling = ref(0.9995);
const saMaxSteps = ref(0);
const saSwapRatio = ref(0.7);
const saBalanceSlack = ref(2.0);
const congestionGridCell = ref(2.0);
const congestionHardThreshold = ref(3.0);
const layerCapacity = ref(1.0);
const capacityUtilization = ref(0.6);
const viaAreaCost = ref(0.1);
const sectorAngleDeg = ref(45.0);
const shortSegmentLen = ref(0.0);              // 短线长度阈值(mm)；0=关闭短线容忍(默认,保持现状)
const shortSegmentCrossingFactor = ref(1.0);   // 短线交叉硬冲突阈值放大系数；1=不放大(默认)
const congestionBalance = ref(false);          // 后处理拥塞均衡；关=不改变现状(默认)
const congestionBalancePasses = ref(20);       // 拥塞均衡最大轮数

// 首启默认 DC 信号预设（cell 2.0 / threshold 3.0）——原项目文档明确"默认 0.8/0.5 对 DC/HV 太严"，
// 默认值若用 probe_layer 原默认会让真实数据大量进人工（实测 1800 线 manual 1758）。
const presetName = ref<"custom" | "hv" | "full" | "ac" | "power">("hv");

const configOverrides = computed(() => {
  const o: Record<string, unknown> = {
    method: method.value,
    optimizer: optimizer.value,
    resolve_conflict_rounds: resolveConflictRounds.value,
    balance_length_rounds: balanceLengthRounds.value,
    minimize_crossings_passes: minimizeCrossingsPasses.value,
    sa_restarts: saRestarts.value,
    sa_initial_temp: saInitialTemp.value,
    sa_cooling: saCooling.value,
    sa_max_steps: saMaxSteps.value,
    sa_swap_ratio: saSwapRatio.value,
    sa_balance_slack: saBalanceSlack.value,
    congestion_grid_cell: congestionGridCell.value,
    congestion_hard_threshold: congestionHardThreshold.value,
    layer_capacity: layerCapacity.value,
    capacity_utilization: capacityUtilization.value,
    via_area_cost: viaAreaCost.value,
    sector_angle_deg: sectorAngleDeg.value,
    short_segment_len: shortSegmentLen.value,
    short_segment_crossing_factor: shortSegmentCrossingFactor.value,
    congestion_balance: congestionBalance.value,
    congestion_balance_passes: congestionBalancePasses.value,
  };
  return o;
});

/** 收集全部参数（含基本输入，供持久化恢复） */
function collectParams(): Record<string, unknown> {
  return {
    preset: presetName.value,
    layers: layers.value,
    width: width.value,
    clearance: clearance.value,
    ...configOverrides.value,
  };
}

/** 把持久化的参数值写回表单（只认已知字段） */
function applyParams(v: Record<string, unknown>): void {
  const num = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : undefined);
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  if (typeof v.preset === "string") applyPreset(v.preset as "custom" | "hv" | "full" | "ac" | "power");
  if (num("layers") !== undefined) layers.value = num("layers")!;
  if (num("width") !== undefined) width.value = num("width")!;
  if (num("clearance") !== undefined) clearance.value = num("clearance")!;
  if (str("method")) method.value = str("method")!;
  if (str("optimizer")) optimizer.value = str("optimizer")!;
  if (typeof v.congestion_balance === "boolean") congestionBalance.value = v.congestion_balance;
  const map: Array<[keyof typeof configOverrides.value, (n: number) => void]> = [
    ["resolve_conflict_rounds", (n) => (resolveConflictRounds.value = n)],
    ["balance_length_rounds", (n) => (balanceLengthRounds.value = n)],
    ["minimize_crossings_passes", (n) => (minimizeCrossingsPasses.value = n)],
    ["sa_restarts", (n) => (saRestarts.value = n)],
    ["sa_initial_temp", (n) => (saInitialTemp.value = n)],
    ["sa_cooling", (n) => (saCooling.value = n)],
    ["sa_max_steps", (n) => (saMaxSteps.value = n)],
    ["sa_swap_ratio", (n) => (saSwapRatio.value = n)],
    ["sa_balance_slack", (n) => (saBalanceSlack.value = n)],
    ["congestion_grid_cell", (n) => (congestionGridCell.value = n)],
    ["congestion_hard_threshold", (n) => (congestionHardThreshold.value = n)],
    ["layer_capacity", (n) => (layerCapacity.value = n)],
    ["capacity_utilization", (n) => (capacityUtilization.value = n)],
    ["via_area_cost", (n) => (viaAreaCost.value = n)],
    ["sector_angle_deg", (n) => (sectorAngleDeg.value = n)],
    ["short_segment_len", (n) => (shortSegmentLen.value = n)],
    ["short_segment_crossing_factor", (n) => (shortSegmentCrossingFactor.value = n)],
    ["congestion_balance_passes", (n) => (congestionBalancePasses.value = n)],
  ];
  for (const [k, set] of map) {
    const n = num(k);
    if (n !== undefined) set(n);
  }
}

function applyPreset(p: "custom" | "hv" | "full" | "ac" | "power"): void {
  presetName.value = p;
  if (p === "hv") {
    // DC 信号推荐：cell 2.0 / threshold 3.0 + 4 层 + 0.2/0.2（对应原项目 in/hv_config.json + README）
    layers.value = 4;
    width.value = 0.2;
    clearance.value = 0.2;
    congestionGridCell.value = 2.0;
    congestionHardThreshold.value = 3.0;
    method.value = "packing";
    optimizer.value = "sa";
  } else if (p === "full") {
    filterPath.value = "";
    layers.value = 4;
    width.value = 0.2;
    clearance.value = 0.2;
    congestionGridCell.value = 0.5;
    congestionHardThreshold.value = 0.8;
    method.value = "packing";
    optimizer.value = "sa";
  } else if (p === "ac") {
    // AC 信号：细线 0.1mm、更多层（12 层）；其余同 DC 预设
    layers.value = 12;
    width.value = 0.1;
    clearance.value = 0.2;
    congestionGridCell.value = 2.0;
    congestionHardThreshold.value = 3.0;
    method.value = "packing";
    optimizer.value = "sa";
  } else if (p === "power") {
    // POWER：宽线 8mm、更多层（20 层）；其余同 DC 预设
    layers.value = 20;
    width.value = 8;
    clearance.value = 0.2;
    congestionGridCell.value = 2.0;
    congestionHardThreshold.value = 3.0;
    method.value = "packing";
    optimizer.value = "sa";
  }
}

/** 人工线占比过高提示（结果页）：超过 30% 大概率是拥塞阈值过严，建议 DC 信号预设 */
const manualRatio = computed(() => {
  if (!result.value) return 0;
  const s = result.value.summary;
  const total = s.wire_assigned_count + s.manual_route_net_count;
  return total > 0 ? s.manual_route_net_count / total : 0;
});

/** 走通率（%）：可布 net / 已分配 net；summary 里由后端起算（routable_ratio），缺省回退计算 */
function routableRatio(s: any): string {
  if (!s) return "—";
  if (typeof s.routable_ratio === "number") return `${Math.round(s.routable_ratio * 100)}%`;
  const t = s.total_net_count, r = s.routable_net_count;
  if (typeof r !== "number" || !(t > 0)) return "—";
  return `${Math.round((r / t) * 100)}%`;
}

/** 走通率（模拟路径版，%）：summary 的 routable_path_ratio；缺省回退计算 */
function routableRatioPath(s: any): string {
  if (!s) return "—";
  if (typeof s.routable_path_ratio === "number") return `${Math.round(s.routable_path_ratio * 100)}%`;
  const t = s.total_net_count, r = s.routable_path_net_count;
  if (typeof r !== "number" || !(t > 0)) return "—";
  return `${Math.round((r / t) * 100)}%`;
}

/** 走通率（**真实可布**·连通分量洪泛，%）：层内"容量内可走"连通区是否贯穿；比直线/路径更诚实 */
function routableRatioFlood(s: any): string {
  if (!s) return "—";
  if (typeof s.routable_flood_ratio === "number") return `${Math.round(s.routable_flood_ratio * 100)}%`;
  const t = s.total_net_count, r = s.routable_flood_net_count;
  // 旧版本/旧任务 summary 无洪泛字段时显示「—」，避免 NaN
  if (typeof r !== "number" || !(t > 0)) return "—";
  return `${Math.round((r / t) * 100)}%`;
}

/* ---------- 内置文件浏览器（layer.listDir；从当前工作区开始，限定在工作区内） ---------- */
const browserOpen = ref(false);
const browserMode = ref<"file" | "dir">("file");
const browserTitle = ref("");
const browserPath = ref("");
const browserEntries = ref<DirEntry[]>([]);
const browserBusy = ref(false);
const browserSelected = ref<string | null>(null);
/* 当前工作区（宿主注入）：文件操作只允许在这个根目录下进行 */
const workspaceRoot = props.api.context.vault ?? "";
/* 文件输入（Inbox，数据根/Input）：待处理文件（如 Allegro pin 表）可只读浏览 */
const inputDir = (props.api.context.inputDir as string | undefined) ?? "";
/* 浏览根来源：工作区 或 文件输入（pin 表向导可在两者间切换） */
type BrowseSource = "workspace" | "input";
const browserSource = ref<BrowseSource>("workspace");
const sourceRoot = computed(() => (browserSource.value === "input" ? inputDir : workspaceRoot));
const hasInputRoot = computed(() => !!inputDir);

async function openBrowser(mode: "file" | "dir", title: string, startPath: string): Promise<void> {
  browserMode.value = mode;
  browserTitle.value = title;
  browserOpen.value = true;
  browserSelected.value = null;
  browserSource.value = "workspace";
  await navigateBrowser(startPath || workspaceRoot);
}

async function navigateBrowser(path: string): Promise<void> {
  browserBusy.value = true;
  browserSelected.value = null;
  try {
    const entries = (await props.api.call("layer.listDir", { path })) as DirEntry[];
    browserPath.value = path ?? "";
    browserEntries.value = entries;
  } catch (e) {
    inputError.value = `浏览失败: ${e}`;
  } finally {
    browserBusy.value = false;
  }
}

/* 上一级：取当前路径的父目录；已在当前浏览根（工作区/文件输入）则禁用（插件亦会钳制，双保险） */
function goUp(): void {
  const root = sourceRoot.value;
  if (browserPath.value === root) return;
  const p = browserPath.value.replace(/[\\/]+$/, "");
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (idx < 0) return;
  const parent = p.slice(0, idx) || root;
  void navigateBrowser(parent);
}

/** 切换浏览根（工作区 ↔ 文件输入），用于 pin 表等待处理文件的定位 */
function switchSource(src: BrowseSource): void {
  if (src === browserSource.value) return;
  browserSource.value = src;
  void navigateBrowser(sourceRoot.value);
}

function enterDir(entry: DirEntry): void {
  if (!entry.isDir) return;
  const base = browserPath.value ? browserPath.value.replace(/\\$/, "") : "";
  void navigateBrowser(base ? `${base}\\${entry.name}` : `${entry.name}\\`);
}

function pickEntry(entry: DirEntry): void {
  if (entry.isDir) {
    if (browserMode.value === "dir") browserSelected.value = entry.name;
    return; // 文件模式点目录只做进入（双击）
  }
  if (browserMode.value === "file") browserSelected.value = entry.name;
}

function confirmBrowser(): void {
  if (browserMode.value === "file") {
    if (!browserSelected.value) return;
    const base = browserPath.value ? browserPath.value.replace(/\\$/, "") : "";
    const full = base ? `${base}\\${browserSelected.value}` : browserSelected.value;
    if (browserTitle.value.includes("输入")) {
      inputPath.value = full;
      // 自动适配输入类型提示
      if (full.toLowerCase().endsWith(".json")) filterPath.value = "";
    } else {
      filterPath.value = full;
    }
  } else {
    if (!browserPath.value) return;
    outDir.value = browserPath.value;
  }
  browserOpen.value = false;
}

/** 完成首次配置：记录 configured=true 并持久化，进入现有页签 */
async function completeSetup(): Promise<void> {
  inputError.value = null;
  if (!inputPath.value.trim()) {
    inputError.value = "请先选择 Allegro pin 表数据文件（必填）";
    return;
  }
  try {
    await props.api.call("layer.config", {
      action: "set",
      patch: {
        configured: true,
        lastInput: inputPath.value.trim(),
        lastFilter: filterPath.value.trim(),
        lastOutDir: outDir.value.trim(),
        ...collectParams(),
      },
    });
    configured.value = true;
    activeTab.value = "input";
  } catch (e) {
    inputError.value = `保存配置失败: ${e}`;
  }
}

/* ---------- 运行 ---------- */
const status = ref<Status>({ state: "idle" });
const jobId = ref<string | null>(null);
const runBusy = ref(false);
const progressEvents = ref<string[]>([]);
const runError = ref<string | null>(null);
const result = ref<JobResult | null>(null);
const pollTimer = ref<number | null>(null);
let lastLoggedProgress = "";
/** 已通知过的 jobId：页面切换重挂载后不重复弹完成通知 */
const notifiedJobs = new Set<string>();

const isRunning = computed(() => status.value.state === "running");
const percent = computed(() => Math.round(status.value.percent ?? 0));

function logEvent(line: string): void {
  progressEvents.value = [...progressEvents.value, line].slice(-20);
}

/** 状态收敛处理：done → 拉结果 + 完成横幅；failed/cancelled → 提示 */
async function handleStatus(s: Status): Promise<void> {
  if (s.state === "running") {
    const key = `${Math.round(s.percent ?? 0)}:${s.message ?? s.stage}`;
    if (key !== lastLoggedProgress) {
      lastLoggedProgress = key;
      logEvent(`[${Math.round(s.percent ?? 0)}%] ${s.message ?? s.stage}`);
    }
    return;
  }
  if (s.state === "done") {
    stopPolling();
    // 仅在前端尚不知道 job（如无 startRun 上下文）时才接收 status.jobId；
    // 否则以 startRun 返回的新 jobId 为准，避免被过期的 status.jobId 覆盖而读到上一次结果。
    if (!jobId.value && s.jobId) jobId.value = s.jobId;
    if (jobId.value) {
      try {
        result.value = (await props.api.call("layer.result", { jobId: jobId.value })) as JobResult;
        activeTab.value = "result";
        logEvent("分层完成");
        // 每个 job 只弹一次完成通知（页面切换重挂载恢复 done 状态时不重复弹）
        if (!notifiedJobs.has(jobId.value)) {
          notifiedJobs.add(jobId.value);
          void props.api.call("layer.notifyDone", {
            title: "探针卡分层完成",
            body: `耗时 ${result.value.summary.elapsed_sec}s，硬冲突 ${result.value.summary.hard_conflict_count}`,
          });
        }
      } catch (e) {
        runError.value = `读取结果失败: ${e}`;
      }
    }
  } else if (s.state === "failed") {
    stopPolling();
    runError.value = s.error ?? "分层失败";
    logEvent(`失败: ${s.error ?? ""}`);
  } else if (s.state === "cancelled") {
    stopPolling();
    logEvent("已取消");
  }
}

async function refreshStatus(): Promise<void> {
  try {
    status.value = (await props.api.call("layer.status")) as Status;
    void handleStatus(status.value);
  } catch (e) {
    runError.value = `状态查询失败: ${e}`;
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer.value = window.setInterval(() => void refreshStatus(), 600);
}

function stopPolling(): void {
  if (pollTimer.value !== null) {
    window.clearInterval(pollTimer.value);
    pollTimer.value = null;
  }
}

async function startRun(): Promise<void> {
  runError.value = null;
  inputError.value = null;
  if (!inputPath.value.trim()) {
    inputError.value = "请选择输入文件（Allegro pin 表 .xls/.xlsx 或旧 JSON）";
    activeTab.value = "input";
    return;
  }
  if (!outDir.value.trim()) {
    inputError.value = "请指定输出目录（必填）";
    activeTab.value = "input";
    return;
  }
  runBusy.value = true;
  progressEvents.value = [];
  result.value = null;
  try {
    const r = (await props.api.call("layer.run", {
      input: inputPath.value.trim(),
      filter: filterPath.value.trim() || undefined,
      outDir: outDir.value.trim(),
      layers: layers.value,
      width: width.value,
      clearance: clearance.value,
      config: configOverrides.value,
    })) as { jobId: string };
    jobId.value = r.jobId;
    status.value = { state: "running", jobId: r.jobId, stage: "启动", percent: 0, message: "启动" };
    activeTab.value = "run";
    startPolling();
    // 记住上次输入与参数（插件设置，下次打开恢复）
    void props.api.call("layer.config", {
      action: "set",
      patch: {
        lastInput: inputPath.value.trim(),
        lastFilter: filterPath.value.trim(),
        lastOutDir: outDir.value.trim(),
        ...collectParams(),
      },
    });
  } catch (e) {
    runError.value = `启动失败: ${e}`;
  } finally {
    runBusy.value = false;
  }
}

async function cancelRun(): Promise<void> {
  try {
    await props.api.call("layer.cancel");
    logEvent("已请求取消…");
  } catch (e) {
    runError.value = `取消失败: ${e}`;
  }
}

/* ---------- 事件订阅（实时补充；进度条以轮询为准） ---------- */
const offProgress = props.api.on("layer.progress", (data) => {
  const d = data as ProgressData;
  logEvent(`[${Math.round(d.percent)}%] ${d.message ?? d.stage}`);
});
const offDone = props.api.on("layer.done", (data) => {
  const d = data as DoneData;
  if (d.jobId === jobId.value) void refreshStatus();
});

/* ---------- 结果页 ---------- */
const layersDetail = computed(() => result.value?.layers ?? []);
const selectedLayer = ref<number | null>(null);
const viewerText = ref<string | null>(null);
const viewerTitle = ref("");

/** PNG data URL（后端 matplotlib 光栅化，浏览器只解码位图）。
 * 不用 SVG：几千条 <path> 的 SVG DOM 交给 WebView2 光栅化是"点开等很久"的
 * 隐藏瓶颈；PNG 直接 <img src> 直显，data: 在宿主 CSP img-src 白名单内。 */
const imgText = ref<string | null>(null);
const imgKind = ref("");
const imgBusy = ref(false);
const imgError = ref<string | null>(null);

/** 已渲染过的图按 jobId+kind 缓存（点过的图秒显，不再调后端） */
const imgCache = new Map<string, string>();

async function renderImage(kind: string): Promise<void> {
  if (!jobId.value) return;
  const cacheKey = `${jobId.value}:${kind}`;
  imgBusy.value = true;
  imgText.value = null;
  imgError.value = null;
  const cached = imgCache.get(cacheKey);
  if (cached !== undefined) {
    imgText.value = cached;
    imgKind.value = kind;
    imgBusy.value = false;
    return;
  }
  try {
    // 后端异步渲染：未命中返回 {"pending": true}（后台线程渲染，宿主 30s 超时不杀进程），
    // 前端轮询直到拿到 PNG data URL（后端缓存命中后秒回）。
    let text: string | null = null;
    for (let i = 0; i < 400; i++) {
      const r = (await props.api.call("layer.render", {
        jobId: jobId.value,
        kind,
      })) as string | { pending?: boolean };
      if (typeof r === "string") {
        text = r;
        break;
      }
      // r.pending —— 后台仍在渲染（matplotlib 首次加载可能较久），等 500ms 再问
      await new Promise((res) => setTimeout(res, 500));
    }
    if (text === null) {
      throw new Error("渲染超时（后台线程长时间无输出）");
    }
    imgCache.set(cacheKey, text);
    imgText.value = text;
    imgKind.value = kind;
  } catch (e) {
    imgText.value = null;
    imgError.value = `渲染失败: ${e}`;
    logEvent(imgError.value);
  } finally {
    imgBusy.value = false;
  }
}

function selectLayer(layer: number): void {
  selectedLayer.value = layer;
  void renderImage(`layer_${layer}`);
}

async function showOverview(): Promise<void> {
  selectedLayer.value = null;
  void renderImage("overview");
}

async function showRose(): Promise<void> {
  selectedLayer.value = null;
  void renderImage("rose");
}

async function showManual(): Promise<void> {
  selectedLayer.value = null;
  void renderImage("manual");
}

async function openOutDir(): Promise<void> {
  if (!result.value) return;
  try {
    await props.api.call("layer.openOut", { outDir: result.value.outDir });
  } catch (e) {
    runError.value = `打开失败: ${e}`;
  }
}

async function viewFile(rel: string): Promise<void> {
  if (!jobId.value) return;
  viewerTitle.value = rel;
  viewerText.value = null;
  try {
    viewerText.value = (await props.api.call("layer.readOut", { jobId: jobId.value, rel })) as string;
  } catch (e) {
    viewerText.value = `读取失败: ${e}`;
  }
}

async function viewReport(): Promise<void> {
  if (!jobId.value) return;
  viewerTitle.value = "json/report.json（冲突明细截断，完整版在输出目录）";
  viewerText.value = null;
  try {
    const r = (await props.api.call("layer.report", { jobId: jobId.value })) as { text: string };
    viewerText.value = r.text;
  } catch (e) {
    viewerText.value = `读取失败: ${e}`;
  }
}

async function copyLst(layer: number): Promise<void> {
  if (!jobId.value) return;
  try {
    const text = (await props.api.call("layer.readOut", {
      jobId: jobId.value,
      rel: `lst/layer_${layer}.lst`,
    })) as string;
    await navigator.clipboard.writeText(text);
    logEvent(`已复制 layer_${layer}.lst`);
  } catch (e) {
    logEvent(`复制失败: ${e}`);
  }
}

const csvFiles = computed(() => result.value?.files.filter((f) => f.endsWith(".csv")) ?? []);
const lstFiles = computed(() =>
  result.value?.files.filter((f) => f.endsWith(".lst") && f.startsWith("lst/")) ?? [],
);

/* ---------- 初始化：恢复上次输入/预设 + 恢复后台任务（离开页面/重启不丢） ---------- */
void (async () => {
  try {
    const r = (await props.api.call("layer.config", { action: "get" })) as {
      settings: Record<string, unknown>;
    };
    const s = r.settings;
    configured.value = !!(s && typeof s === "object" && s.configured === true);
    if (typeof s.lastInput === "string" && s.lastInput) inputPath.value = s.lastInput;
    if (typeof s.lastFilter === "string" && s.lastFilter) filterPath.value = s.lastFilter;
    if (typeof s.lastOutDir === "string" && s.lastOutDir) outDir.value = s.lastOutDir;
    if (s && typeof s === "object" && "preset" in s) {
      applyParams(s); // 恢复上次预设与全部参数（含 layers/width/clearance）
    } else {
      applyPreset("hv"); // 首次使用：默认 DC 信号预设（默认 0.5/0.8 对 DC/HV 太严）
    }
  } catch {
    applyPreset("hv");
  }
  // 恢复后台任务：layer.status 带 jobId（camelCase）→ running 续轮询 / done 拉结果
  try {
    status.value = (await props.api.call("layer.status")) as Status;
  } catch (e) {
    runError.value = `状态查询失败: ${e}`;
    return;
  }
  if (status.value.state === "running") {
    jobId.value = status.value.jobId ?? null;
    activeTab.value = "run"; // 直接回到运行页看进度
    logEvent(`[${Math.round(status.value.percent ?? 0)}%] ${status.value.message ?? status.value.stage}`);
    startPolling();
  } else if (status.value.state === "done" && status.value.jobId) {
    jobId.value = status.value.jobId;
    activeTab.value = "result"; // 上次任务已完成，直接进结果页
    try {
      result.value = (await props.api.call("layer.result", { jobId: jobId.value })) as JobResult;
      notifiedJobs.add(jobId.value); // 恢复态不重复弹完成通知
      logEvent("分层完成（恢复上次结果）");
    } catch {
      runError.value = "读取上次结果失败（输出目录可能已移动）";
    }
  } else if (status.value.state === "failed" || status.value.state === "cancelled") {
    activeTab.value = "run";
    runError.value = status.value.error ?? (status.value.state === "failed" ? "上次分层失败" : "上次分层已取消");
  }
})();

/* 输入/参数变化即持久化（防抖 600ms）：离开页面再回来表单不丢。
 * 之前只在点「开始分层」时存一次 settings——填了一半切走页面就全没了。 */
let persistTimer: number | null = null;
watch(
  () => [
    inputPath.value, filterPath.value, outDir.value,
    presetName.value, layers.value, width.value, clearance.value,
    method.value, optimizer.value, resolveConflictRounds.value,
    balanceLengthRounds.value, minimizeCrossingsPasses.value, saRestarts.value,
    saInitialTemp.value, saCooling.value, saMaxSteps.value, saSwapRatio.value,
    saBalanceSlack.value, congestionGridCell.value, congestionHardThreshold.value,
    layerCapacity.value, capacityUtilization.value, viaAreaCost.value,
    sectorAngleDeg.value,
  ],
  () => {
    if (persistTimer !== null) window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      void props.api.call("layer.config", {
        action: "set",
        patch: {
          lastInput: inputPath.value.trim(),
          lastFilter: filterPath.value.trim(),
          lastOutDir: outDir.value.trim(),
          ...collectParams(),
        },
      });
    }, 600);
  },
);

/* 轮询期间状态收敛（含 done/failed 分支，由 refreshStatus 内部调用） */
onBeforeUnmount(() => {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  stopPolling();
  offProgress();
  offDone();
});
</script>

<template>
  <div class="prl-ui">
    <!-- ═══ 首次配置向导：未完成路径配置时替代页签 ═══ -->
    <section v-if="!configured" class="prl-setup">
      <div class="prl-setup-head">
        <h2>首次使用：配置分层输入</h2>
        <p>从 Allegro 导出的 <strong>pin 表数据文件</strong>出发；配置好即可进入分层。之后可在「输入设置」随时修改。</p>
      </div>
      <div v-if="inputError" class="prl-error" role="alert">{{ inputError }}</div>
      <div class="prl-card">
        <div class="prl-field">
          <label class="prl-label">Allegro pin 表数据文件（.xls/.xlsx，兼容旧 JSON）— 必填</label>
          <div class="prl-row">
            <input v-model="inputPath" class="prl-input" placeholder="如 D:\...\in\1.xlsx" />
            <button class="prl-btn" @click="openBrowser('file', '选择输入文件', '')">浏览</button>
          </div>
          <p class="prl-hint">
            文件可在当前工作区或「文件输入」目录中浏览选择——通常 Allegro 导出的文件先放到
            文件输入（Inbox），再在这里选中开始分层。
          </p>
        </div>
      </div>
      <div class="prl-actions">
        <button class="prl-btn prl-btn-primary" :disabled="!inputPath.trim()" @click="completeSetup">
          完成配置，开始使用
        </button>
      </div>
    </section>

    <!-- 页签：固定不随内容滚动（内容在 prl-body 内独立滚动） -->
    <nav v-if="configured" class="prl-tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="prl-tab"
        :class="{ active: activeTab === t.id }"
        role="tab"
        :aria-selected="activeTab === t.id"
        @click="activeTab = t.id"
      >
        {{ t.label }}
      </button>
    </nav>

    <div v-if="configured" class="prl-body">
      <!-- ═══ Tab 1 输入设置 ═══ -->
      <section v-show="activeTab === 'input'" class="prl-pane">
      <div v-if="inputError" class="prl-error" role="alert">{{ inputError }}</div>

      <div class="prl-card">
        <div class="prl-card-head">
          <h3>输入文件</h3>
          <code class="prl-cmd">api.call("layer.listDir")</code>
        </div>
        <div class="prl-field">
          <label class="prl-label">输入 1：Allegro pin 表（.xls/.xlsx，兼容旧 JSON）</label>
          <div class="prl-row">
            <input v-model="inputPath" class="prl-input" placeholder="D:\...\in\1.xlsx" />
            <button class="prl-btn" @click="openBrowser('file', '选择输入文件', '')">浏览</button>
          </div>
        </div>
        <div class="prl-field">
          <label class="prl-label">
            输入 2：筛选文件（可选；.lst/.txt 一行一个 net，空行/# 注释跳过；兼容 .xls/.xlsx）
          </label>
          <div class="prl-row">
            <input v-model="filterPath" class="prl-input" placeholder="D:\...\filter_example.lst" />
            <button class="prl-btn" @click="openBrowser('file', '选择筛选文件', '')">浏览</button>
            <button class="prl-btn" @click="filterPath = ''">清除</button>
          </div>
          <p class="prl-hint">
            不在筛选文件里的 net 全部不要；建议均匀覆盖圆各扇区（只圈一个扇区会全挤圆心）。
            想控制规模/提速可先抽样导出一份筛选用 lst。
          </p>
        </div>
        <div class="prl-field">
          <label class="prl-label">输出目录（必填，强制指定）</label>
          <div class="prl-row">
            <input v-model="outDir" class="prl-input" placeholder="D:\...\out_demo" />
            <button class="prl-btn" @click="openBrowser('dir', '选择输出目录', '')">浏览</button>
          </div>
          <p class="prl-hint">必须在当前工作区内；未创建会自动创建。产出 report.json / layer_N.lst / csv 等</p>
        </div>
        <div class="prl-field">
          <label class="prl-label">预设</label>
          <div class="prl-row">
            <select v-model="presetName" class="prl-input prl-select" @change="applyPreset(presetName)">
              <option value="custom">自定义</option>
              <option value="hv">DC 信号（cell 2.0 / threshold 3.0 / 4 层 / 0.2mm）</option>
              <option value="ac">AC（细线 0.1mm / 12 层）</option>
              <option value="power">POWER（宽线 8mm / 20 层）</option>
              <option value="full">全量（不筛选）</option>
            </select>
          </div>
          <p class="prl-hint">预设=一组推荐的层数/线宽/线距/拥塞参数，一键套用；选「自定义」再逐项微调下面的参数</p>
        </div>
        <div class="prl-grid3">
          <div class="prl-field">
            <label class="prl-label">层数（xlsx 输入）</label>
            <input v-model.number="layers" type="number" min="1" max="40" class="prl-input" />
            <p class="prl-field-hint">信号层数（Allegro 建层数）。越多每层越不挤、越散，但超过实际层数无用。推荐：DC/HV 4、AC 12、POWER 20（预设已带）；旧 JSON 输入由文件决定</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">线宽 mm（DC 0.2 / AC 0.1 / POWER 8）</label>
            <input v-model.number="width" type="number" step="0.05" class="prl-input" />
            <p class="prl-field-hint">信号线宽 mm，直接影响每层占用（越宽越挤、越易判硬冲突）。推荐：DC/HV 0.2、AC 0.1、POWER 8（预设已带，保持与真实板一致）</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">线距 mm</label>
            <input v-model.number="clearance" type="number" step="0.05" class="prl-input" />
            <p class="prl-field-hint">线与线最小间距 mm，参与拥塞占用估算：越大占用越大、越易判冲突。推荐 0.2（与板子实际一致）</p>
          </div>
        </div>
      </div>

      <div class="prl-actions">
        <button class="prl-btn prl-btn-primary" @click="activeTab = 'params'">下一步：分层参数</button>
      </div>
    </section>

    <!-- ═══ Tab 2 分层参数 ═══ -->
    <section v-show="activeTab === 'params'" class="prl-pane">
      <div class="prl-card">
        <div class="prl-card-head"><h3>参数速查（先看这里）</h3></div>
        <p class="prl-hint">
          三块参数分别控制：<strong>方法/迭代</strong>＝怎么分层；<strong>SA</strong>＝分层后的精修质量；
          <strong>拥塞估计</strong>＝判定哪些交叉算"硬冲突"（决定走人工）。<br />
          <strong>质量 vs 速度</strong>：所有"轮数/步数/多起点"越大 → 质量越好、越慢（推荐先用预设默认，不满意再加）。<br />
          <strong>最关键的旋钮</strong>：<code>硬冲突阈值</code>——<u>越大越宽松</u>（硬冲突、需人工越少，但同层交叉更多）；
          <code>层容量</code>——越大每层塞得越多、层数越少（建议 ≤1.0，勿 &gt;1）。<br />
          <strong>圆心拥塞</strong>：若层占用峰值仍 &gt;1.0（圆心/圆心处线挤），开启<strong>「拥塞均衡」</strong>
          （后处理压峰值，实测 1.56→1.11 + 走通率到 100%，仅 +0.2s）。<br />
          <strong>推荐路径</strong>：先选「输入设置→预设」，再回来微调；DC/HV 用 cell 2.0 + threshold 3.0，
          AC 12 层 / POWER 20 层（预设已带）。
        </p>
      </div>
      <div class="prl-card">
        <div class="prl-card-head">
          <h3>分层方法与迭代</h3>
          <code class="prl-cmd">LayeringConfig 字段</code>
        </div>
        <div class="prl-grid2">
          <div class="prl-field">
            <label class="prl-label">方法 method</label>
            <select v-model="method" class="prl-input prl-select">
              <option value="packing">packing（扇区轮询，默认）</option>
              <option value="dsatur">dsatur（图着色基线）</option>
            </select>
            <p class="prl-field-hint">
              分层算法：<strong>packing</strong>（扇区轮询，默认，效果好）；<strong>dsatur</strong>（图着色，只作基线对比）。
              推荐 packing。
            </p>
          </div>
          <div class="prl-field">
            <label class="prl-label">精修 optimizer</label>
            <select v-model="optimizer" class="prl-input prl-select">
              <option value="sa">sa（模拟退火，默认）</option>
              <option value="greedy">greedy（只贪心）</option>
              <option value="none">none（关精修）</option>
            </select>
            <p class="prl-field-hint">packing 后的精修：<strong>sa</strong>（模拟退火，默认，质量最好但慢）；<strong>greedy</strong>（只局部贪心）；<strong>none</strong>（关精修，最快但质量差）。推荐 sa</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">迭代① 硬冲突微调轮数</label>
            <input v-model.number="resolveConflictRounds" type="number" min="0" class="prl-input" />
            <p class="prl-field-hint">同层硬冲突（交点拥塞超阈值）的微调轮数：越大硬冲突越少、越慢。默认 8，推荐 8–15</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">迭代② 长短均衡轮数</label>
            <input v-model.number="balanceLengthRounds" type="number" min="0" class="prl-input" />
            <p class="prl-field-hint">各层线长均衡的交换轮数：越大各层线长越均衡、越慢。默认 3，推荐 3–6</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">迭代③ 贪心交叉轮数</label>
            <input v-model.number="minimizeCrossingsPasses" type="number" min="0" class="prl-input" />
            <p class="prl-field-hint">贪心最小化软冲突（线对交叉）的轮数：越大软冲突越少、越慢。默认 3，推荐 3–6</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">迭代④ SA 多起点（耗时 ×N）</label>
            <input v-model.number="saRestarts" type="number" min="1" class="prl-input" />
            <p class="prl-field-hint">SA 多起点次数：&gt;1 时多次退火取最优，结果更稳但耗时按倍数增加。默认 1 够用；追求更稳再 3–5</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">扇区角 sector_angle_deg（360/45=8 扇区）</label>
            <input v-model.number="sectorAngleDeg" type="number" min="5" step="5" class="prl-input" />
            <p class="prl-field-hint">把圆按角度分成扇区轮询：360/45=8 扇区。默认 45°；越小扇区越多、层间更均匀但更碎。推荐 30–60°</p>
          </div>
        </div>
      </div>

      <div class="prl-card">
        <div class="prl-card-head">
          <h3>SA 精修参数</h3>
          <code class="prl-cmd">仅 optimizer=sa 时生效</code>
        </div>
        <div class="prl-grid3">
          <div class="prl-field">
            <label class="prl-label">初始温度</label>
            <input v-model.number="saInitialTemp" type="number" step="0.5" class="prl-input" />
            <p class="prl-field-hint">退火起始温度（软冲突对数尺度）：越高初期越敢接受恶化、探索越广。默认 8，推荐 5–12</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">降温系数</label>
            <input v-model.number="saCooling" type="number" step="0.0001" class="prl-input" />
            <p class="prl-field-hint">每步温度乘数（慢降温探索充分）：越接近 1 越慢越充分、耗时越长。默认 0.9995（接近 1，建议保持）</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">步数（0=自动 max(4000, 30×线数)）</label>
            <input v-model.number="saMaxSteps" type="number" min="0" class="prl-input" />
            <p class="prl-field-hint">退火总步数：0=自动（max(4000, 30×线数)）。越大搜索越充分、越慢。推荐 0（自动）</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">交换移动占比</label>
            <input v-model.number="saSwapRatio" type="number" min="0" max="1" step="0.1" class="prl-input" />
            <p class="prl-field-hint">每步移动中"交换两线归属"的比例（其余为"单线换层"）。默认 0.7，推荐 0.5–0.8</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">均衡护栏 slack</label>
            <input v-model.number="saBalanceSlack" type="number" min="1" step="0.1" class="prl-input" />
            <p class="prl-field-hint">均衡护栏：允许目标值恶化到初始值的倍数（防过度破坏线长均衡）。默认 2，推荐 1.5–3</p>
          </div>
        </div>
      </div>

      <div class="prl-card">
        <div class="prl-card-head">
          <h3>拥塞估计</h3>
          <code class="prl-cmd">决定"哪些线进人工 route"</code>
        </div>
        <div class="prl-grid3">
          <div class="prl-field">
            <label class="prl-label">拥塞网格 cell mm（HV 用 2.0）</label>
            <input v-model.number="congestionGridCell" type="number" step="0.5" class="prl-input" />
            <p class="prl-field-hint">拥塞网格边长 mm：越小判得越细、但越易判冲突（更严）。默认 0.5（偏严）；DC/HV 推荐 2.0，全量 0.5</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">硬冲突阈值（HV 用 3.0）</label>
            <input v-model.number="congestionHardThreshold" type="number" step="0.1" class="prl-input" />
            <p class="prl-field-hint">交点拥塞超过该值判<strong>硬冲突</strong>。<u>越大越宽松</u>（硬冲突、需人工越少，但同层交叉更多）。默认 0.8 太严；DC/HV 推荐 3.0，全量 0.8</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">层容量（勿 >1）</label>
            <input v-model.number="layerCapacity" type="number" step="0.05" class="prl-input" />
            <p class="prl-field-hint">每层 occupancy 上限（布线容量，满=1.0）：越大每层塞得越多、层数越少。默认 1.0；建议 ≤1.0（勿 &gt;1）</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">容量利用率</label>
            <input v-model.number="capacityUtilization" type="number" min="0" max="1" step="0.1" class="prl-input" />
            <p class="prl-field-hint">目标容量利用率（低于 100% 留余量）：越小越保守、层数越多。默认 0.6，推荐 0.5–0.7</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">过孔预留比例</label>
            <input v-model.number="viaAreaCost" type="number" step="0.05" class="prl-input" />
            <p class="prl-field-hint">过孔占用面积的折算成本：越大越避免线挤在过孔密集区。默认 0.1</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">短线长度阈值 mm（0=关闭短线容忍）</label>
            <input v-model.number="shortSegmentLen" type="number" min="0" step="0.5" class="prl-input" />
            <p class="prl-field-hint">长度 ≤ 该值的段视为"短线"，其交叉更受宽容（见下一项）。默认 0=关闭（现状）；想容忍短线交叉再设 5–10mm</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">短线交叉硬阈值放大（1=不放大）</label>
            <input v-model.number="shortSegmentCrossingFactor" type="number" min="1" step="0.5" class="prl-input" />
            <p class="prl-field-hint">短线交叉需交点拥塞 ≥ 硬冲突阈值×本系数才判硬，否则按<strong>软</strong>。越大短线交叉越易同层（更宽容）；默认 1=不放大，推荐 1.5–3</p>
          </div>
          <div class="prl-field">
            <label class="prl-label">拥塞均衡（后处理压峰值）</label>
            <input v-model="congestionBalance" type="checkbox" class="prl-input" />
            <p class="prl-field-hint">分层后把超容层/格点上的线平衡到低拥塞层，<strong>摊平圆心/圆心层占用峰值</strong>（实测 hv 1800 网：峰值 <strong>1.56→1.11</strong>、走通率(洪泛) <strong>98.7%→100%</strong>、需人工/硬·软冲突不变、仅 +0.24s）。默认关=不改变现状；<strong>DC/HV 建议开启</strong></p>
          </div>
          <div class="prl-field">
            <label class="prl-label">拥塞均衡轮数</label>
            <input v-model.number="congestionBalancePasses" type="number" min="1" step="5" class="prl-input" />
            <p class="prl-field-hint">最大轮数：越大摊得越彻底、越慢。默认 20，推荐 10–40（超过后基本无收益）</p>
          </div>
        </div>
        <p class="prl-hint">「硬冲突阈值」越大越宽松（硬冲突、需人工越少，但同层交叉更多）；开启「拥塞均衡」可压圆心层占用峰值（实测 1.56→1.11）+ 走通率到 100%。其余参数未列出的字段用 probe_layer 默认值。短线容忍、拥塞均衡均默认关闭，行为与现状一致</p>
      </div>

      <div class="prl-actions">
        <button class="prl-btn" @click="activeTab = 'input'">上一步</button>
        <button class="prl-btn prl-btn-primary" @click="activeTab = 'run'">下一步：运行</button>
      </div>
    </section>

    <!-- ═══ Tab 3 运行 ═══ -->
    <section v-show="activeTab === 'run'" class="prl-pane">
      <div v-if="runError" class="prl-error" role="alert">{{ runError }}</div>

      <div class="prl-card">
        <div class="prl-card-head">
          <h3>运行分层</h3>
          <code class="prl-cmd">layer.run（后台线程，秒回 jobId）</code>
        </div>
        <p class="prl-meta">
          输入：{{ inputPath || "（未选择）" }}
          <template v-if="filterPath"> ｜ 筛选：{{ filterPath }}</template>
          <br />输出：{{ outDir || "（未指定）" }} ｜ 层数 {{ layers }} / 线宽 {{ width }} / 线距 {{ clearance }}
        </p>
        <p v-if="presetName === 'custom' && congestionHardThreshold < 1.5" class="prl-warn prl-warn-inline">
          ⚠️ 当前是自定义参数且拥塞阈值 {{ congestionHardThreshold }} 偏严（DC 信号推荐 3.0）——
          真实数据可能大量进人工清单，建议先用「DC 信号预设」。
        </p>
        <div class="prl-actions">
          <button class="prl-btn prl-btn-primary" :disabled="runBusy || isRunning" @click="startRun">
            {{ runBusy ? "启动中…" : isRunning ? "运行中…" : "开始分层" }}
          </button>
          <button class="prl-btn" :disabled="!isRunning" @click="cancelRun">取消</button>
        </div>

        <div v-if="isRunning" class="prl-progress">
          <div class="prl-progress-track">
            <div class="prl-progress-fill" :style="{ width: percent + '%' }" />
          </div>
          <div class="prl-progress-meta">
            <span>{{ status.message || status.stage }}</span>
            <span>{{ percent }}%</span>
          </div>
        </div>
      </div>

      <div v-if="progressEvents.length" class="prl-card">
        <div class="prl-card-head"><h3>事件流</h3></div>
        <TransitionGroup tag="ul" name="prl-list" class="prl-events">
          <li v-for="(e, i) in progressEvents.slice(-8).reverse()" :key="i" class="prl-event">{{ e }}</li>
        </TransitionGroup>
      </div>
    </section>

    <!-- ═══ Tab 4 结果 ═══ -->
    <section v-show="activeTab === 'result'" class="prl-pane">
      <template v-if="result">
        <div class="prl-card">
          <div class="prl-card-head">
            <h3>摘要</h3>
            <div class="prl-actions prl-actions-inline">
              <button class="prl-btn" @click="openOutDir">打开输出目录</button>
            </div>
          </div>
          <div class="prl-summary-grid">
            <div class="prl-stat"><span class="prl-stat-num">{{ result.summary.layer_count }}</span><span>层数</span></div>
            <div class="prl-stat"><span class="prl-stat-num">{{ result.summary.wire_assigned_count }}</span><span>已分配线</span></div>
            <div class="prl-stat"><span class="prl-stat-num">{{ result.summary.hard_conflict_count }}</span><span>硬冲突</span></div>
            <div class="prl-stat"><span class="prl-stat-num">{{ result.summary.soft_conflict_count }}</span><span>软冲突</span></div>
            <div class="prl-stat"><span class="prl-stat-num">{{ result.summary.manual_route_net_count }}</span><span>人工 route</span></div>
            <div class="prl-stat"><span class="prl-stat-num">{{ routableRatio(result.summary) }}</span><span>走通率(直线)</span></div>
            <div class="prl-stat"><span class="prl-stat-num">{{ routableRatioPath(result.summary) }}</span><span>走通率(路径)</span></div>
            <div class="prl-stat"><span class="prl-stat-num">{{ routableRatioFlood(result.summary) }}</span><span>走通率(真实可布)</span></div>
            <div class="prl-stat"><span class="prl-stat-num">{{ result.summary.elapsed_sec }}s</span><span>耗时</span></div>
          </div>
          <p v-if="result.summary.warnings.length" class="prl-meta">
            警告：{{ result.summary.warnings.join("；") }}
          </p>
        </div>

        <!-- 人工线占比过高 → 大概率拥塞阈值过严，给出一键改 HV 预设 -->
        <div v-if="manualRatio > 0.3" class="prl-warn" role="alert">
          <div class="prl-warn-body">
            <strong>{{ (manualRatio * 100).toFixed(0) }}% 的线进了人工 route 清单</strong>
            <span>通常是拥塞参数太严（默认 threshold 0.8 / cell 0.5 对 DC 信号偏严，会把绝大多数线判为硬冲突）。</span>
          </div>
          <button class="prl-btn prl-btn-primary" @click="applyPreset('hv'); activeTab = 'run'">
            应用 DC 信号预设并重跑
          </button>
        </div>

        <div class="prl-card">
          <div class="prl-card-head">
            <h3>各层统计（点击层查看图）</h3>
            <div class="prl-actions prl-actions-inline">
              <button class="prl-btn" @click="showOverview">总览图</button>
              <button class="prl-btn" @click="showRose">玫瑰图</button>
              <button
                v-if="result.summary.manual_route_net_count > 0"
                class="prl-btn"
                @click="showManual"
              >人工 route 图（{{ result.summary.manual_route_net_count }}）</button>
              <button class="prl-btn" @click="viewReport">查看 report.json</button>
            </div>
          </div>
          <table class="prl-table">
            <thead>
              <tr>
                <th>层</th><th>类型</th><th>net 数</th><th>线数</th>
                <th>软冲突</th><th>占用率</th><th></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="li in layersDetail"
                :key="li.layer"
                :class="{ active: selectedLayer === li.layer }"
                @click="selectLayer(li.layer)"
              >
                <td>{{ li.layer }}</td>
                <td>{{ li.kind }}</td>
                <td>{{ li.net_count }}</td>
                <td>{{ li.wire_count }}</td>
                <td>{{ li.soft_conflict_count }}</td>
                <td>{{ li.max_occupancy }}</td>
                <td><button class="prl-btn prl-btn-sm" @click.stop="copyLst(li.layer)">复制 .lst</button></td>
              </tr>
            </tbody>
          </table>
          <p v-if="!layersDetail.length" class="prl-meta">（无信号层数据）</p>
        </div>

        <div v-if="imgText || imgBusy || imgError" class="prl-card">
          <div class="prl-card-head">
            <h3>{{ imgKind }}（PNG，按需渲染）</h3>
            <span v-if="imgBusy" class="prl-meta">渲染中…（首次约 1.5s）</span>
          </div>
          <div v-if="imgError" class="prl-error" role="alert">{{ imgError }}</div>
          <div v-if="imgText" class="prl-svg"><img :src="imgText" alt="分层图" /></div>
        </div>

        <div class="prl-card">
          <div class="prl-card-head">
            <h3>输出文件</h3>
          </div>
          <div class="prl-file-list">
            <button
              v-for="f in lstFiles"
              :key="f"
              class="prl-file-btn"
              @click="viewFile(f)"
            >{{ f }}</button>
            <button
              v-for="f in csvFiles"
              :key="f"
              class="prl-file-btn"
              @click="viewFile(f)"
            >{{ f }}</button>
          </div>
          <pre v-if="viewerText" class="prl-viewer"><small>{{ viewerTitle }}</small>{{ viewerText }}</pre>
        </div>
      </template>
      <div v-else class="prl-empty">尚无结果 —— 先到「运行」页开始一次分层</div>
    </section>
    </div><!-- /prl-body -->

    <!-- ═══ 文件浏览器弹层 ═══ -->
    <div v-if="browserOpen" class="prl-modal" @click.self="browserOpen = false">
      <div class="prl-modal-box">
        <div class="prl-card-head">
          <h3>{{ browserTitle }}</h3>
          <button class="prl-btn prl-btn-sm" @click="browserOpen = false">关闭</button>
        </div>
        <div class="prl-row prl-breadcrumb">
          <button
            class="prl-btn prl-btn-sm"
            :class="{ 'prl-btn-primary': browserSource === 'workspace' }"
            @click="switchSource('workspace')"
          >工作区</button>
          <button
            v-if="hasInputRoot"
            class="prl-btn prl-btn-sm"
            :class="{ 'prl-btn-primary': browserSource === 'input' }"
            @click="switchSource('input')"
          >文件输入</button>
          <button class="prl-btn prl-btn-sm" :disabled="browserPath === sourceRoot" @click="goUp">上一级</button>
          <span class="prl-path">{{ browserPath || "（工作区根）" }}</span>
        </div>
        <div class="prl-browser">
          <div v-if="browserBusy" class="prl-empty">读取中…</div>
          <template v-else>
            <div
              v-for="e in browserEntries"
              :key="e.name"
              class="prl-browser-item"
              :class="{ selected: browserSelected === e.name, dir: e.isDir }"
              @click="pickEntry(e)"
              @dblclick="enterDir(e)"
            >
              <span class="prl-browser-icon">{{ e.isDir ? "📁" : "📄" }}</span>
              <span class="prl-browser-name">{{ e.name }}</span>
              <span v-if="!e.isDir && e.size != null" class="prl-browser-size">{{ (e.size / 1024).toFixed(0) }} KB</span>
            </div>
            <div v-if="!browserEntries.length" class="prl-empty">（空目录）</div>
          </template>
        </div>
        <div class="prl-actions prl-actions-end">
          <button
            v-if="browserMode === 'dir' && browserPath"
            class="prl-btn prl-btn-primary"
            @click="confirmBrowser"
          >选择此目录</button>
          <button
            v-else-if="browserMode === 'file' && browserSelected"
            class="prl-btn prl-btn-primary"
            @click="confirmBrowser"
          >选择 {{ browserSelected }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* 只引用宿主设计令牌（tokens.css 变量）；类名统一 prl-* 前缀避免污染宿主。 */
.prl-ui {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
}
/* 首次配置向导：居中卡片流，替代页签 */
.prl-setup {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-4);
  max-width: 560px;
  width: 100%;
  margin: 0 auto;
  padding: var(--space-8);
  box-sizing: border-box;
}
.prl-setup-head h2 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: -0.02em;
}
.prl-setup-head p {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  line-height: 1.6;
}
.prl-tabs {
  flex: none;
  display: flex;
  gap: var(--space-1);
  border-bottom: 1px solid var(--border);
  padding: var(--space-2) var(--space-6);
  background: var(--bg);
  z-index: 2;
}
.prl-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
}
.prl-tab {
  padding: 8px 16px;
  border: none;
  background: none;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.prl-tab:hover { color: var(--fg); background: var(--bg-soft); }
.prl-tab.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); font-weight: 650; }
.prl-pane { display: flex; flex-direction: column; gap: var(--space-4); }
.prl-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-1);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.prl-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
.prl-card-head h3 { margin: 0; font-size: var(--text-md); font-weight: 650; }
.prl-cmd { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-faint); }
.prl-field { display: flex; flex-direction: column; gap: 6px; }
.prl-label { font-size: var(--text-xs); color: var(--fg-muted); }
.prl-row { display: flex; gap: var(--space-2); align-items: center; }
.prl-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: var(--space-3); }
.prl-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); }
.prl-input {
  width: 100%;
  min-width: 0;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg);
  font-size: var(--text-sm);
  font-family: inherit;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
/* 行内并排时（如「输入 + 浏览」）让输入框弹性填充剩余宽度 */
.prl-row .prl-input,
.prl-row .prl-select {
  flex: 1;
  width: auto;
}
.prl-input::placeholder { color: var(--fg-faint); }
.prl-input:focus,
.prl-select:focus,
.prl-textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.prl-input:disabled,
.prl-select:disabled { opacity: 0.55; cursor: not-allowed; }
.prl-textarea { resize: vertical; min-height: 72px; }
/* 下拉/数值：与文本输入同高同形，值用统一字号；隐藏原生下拉箭头改为自定义 caret */
.prl-select {
  width: 100%;
  flex: none;
  appearance: none;
  padding: 7px 30px 7px 12px;
  background-image: linear-gradient(45deg, transparent 50%, var(--fg-muted) 50%),
    linear-gradient(135deg, var(--fg-muted) 50%, transparent 50%);
  background-position: calc(100% - 16px) calc(50% - 2px), calc(100% - 11px) calc(50% - 2px);
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
}
/* 数字输入：隐藏原生增减按钮（自绘感与文本输入一致），保留上下键可用 */
.prl-input[type="number"] { appearance: textfield; -moz-appearance: textfield; }
.prl-input[type="number"]::-webkit-inner-spin-button,
.prl-input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.prl-hint { margin: 0; font-size: var(--text-xs); color: var(--fg-faint); line-height: 1.6; }
/* 参数小字解释：字段下方一行，说明含义/影响/默认值 */
.prl-field-hint { margin: 0; font-size: var(--text-xs); color: var(--fg-faint); line-height: 1.55; }
.prl-meta { margin: 0; font-size: var(--text-xs); color: var(--fg-muted); line-height: 1.7; }
.prl-error {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 12px;
  background: var(--pastel-red-bg);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--pastel-red-fg);
  word-break: break-word;
}
.prl-warn {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--pastel-yellow-bg, #fff7d6);
  border: 1px solid var(--pastel-yellow-fg, #d9a400);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  color: var(--fg);
}
.prl-warn-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.prl-warn-body span {
  font-size: var(--text-xs);
  color: var(--fg-muted);
  line-height: 1.6;
}
.prl-warn-inline {
  justify-content: flex-start;
  padding: 8px 12px;
  font-size: var(--text-xs);
}
.prl-actions { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.prl-actions-inline { gap: var(--space-1); }
.prl-actions-end { justify-content: flex-end; }
.prl-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg-muted);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.prl-btn:hover:not(:disabled) { color: var(--fg); border-color: var(--border-strong); background: var(--bg-elevated); }
.prl-btn:active:not(:disabled) { transform: scale(0.97); }
.prl-btn:disabled { opacity: 0.5; cursor: default; }
.prl-btn:focus-visible, .prl-input:focus-visible, .prl-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.prl-btn-primary { background: var(--accent); border-color: transparent; color: var(--on-accent); }
.prl-btn-primary:hover:not(:disabled) { background: var(--accent-strong); border-color: transparent; color: var(--on-accent); }
.prl-btn-sm { padding: 4px 10px; font-size: var(--text-xs); }
.prl-progress { display: flex; flex-direction: column; gap: 6px; }
.prl-progress-track { height: 8px; border-radius: 999px; background: var(--bg-soft); overflow: hidden; }
.prl-progress-fill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 300ms var(--ease); }
.prl-progress-meta { display: flex; justify-content: space-between; font-size: var(--text-xs); color: var(--fg-muted); }
.prl-events { margin: 0; padding: var(--space-2) var(--space-3); list-style: none; background: var(--bg-soft); border-radius: var(--radius-md); }
.prl-event { font-family: var(--font-mono); font-size: 11px; line-height: 1.7; color: var(--fg-muted); }
.prl-list-enter-active, .prl-list-leave-active { transition: opacity 180ms var(--ease), transform 180ms var(--ease); }
.prl-list-enter-from { opacity: 0; transform: translateY(6px); }
.prl-list-leave-to { opacity: 0; transform: translateY(-4px); }
.prl-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-3); }
.prl-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: var(--space-3);
  background: var(--bg-soft);
  border-radius: var(--radius-md);
  font-size: var(--text-xs);
  color: var(--fg-muted);
}
.prl-stat-num { font-size: var(--text-xl); font-weight: 700; color: var(--fg); }
.prl-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.prl-table th, .prl-table td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.prl-table th { font-size: var(--text-xs); color: var(--fg-muted); font-weight: 600; }
.prl-table tr { cursor: pointer; }
.prl-table tr:hover { background: var(--bg-soft); }
.prl-table tr.active { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.prl-svg { border: 1px solid var(--border); border-radius: var(--radius-md); background: #fff; overflow: auto; height: 60vh; display: flex; align-items: center; justify-content: center; }
.prl-svg img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; }
.prl-file-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.prl-file-btn {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.prl-file-btn:hover { color: var(--fg); border-color: var(--border-strong); }
.prl-viewer {
  margin: 0;
  padding: var(--space-3);
  background: var(--bg-soft);
  border-radius: var(--radius-md);
  font-size: 11px;
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow: auto;
}
.prl-viewer small { display: block; margin-bottom: 6px; color: var(--fg-faint); }
.prl-empty { padding: var(--space-4); text-align: center; color: var(--fg-faint); font-size: var(--text-sm); }
.prl-modal {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, #000 35%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.prl-modal-box {
  width: min(640px, 92vw);
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-5);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
}
.prl-breadcrumb { padding: 0 var(--space-1); }
.prl-path { font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prl-browser { flex: 1; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-soft); min-height: 180px; }
.prl-browser-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 12px;
  font-size: var(--text-sm);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.prl-browser-item:hover { background: var(--bg-elevated); }
.prl-browser-item.selected { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.prl-browser-icon { flex: none; }
.prl-browser-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prl-browser-size { flex: none; font-size: 11px; color: var(--fg-faint); }
</style>
