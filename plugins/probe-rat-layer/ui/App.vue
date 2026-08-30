<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
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
 * - 图片用 layer.render 按需渲染（matplotlib 懒加载），返回 SVG 文本内联显示。
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
const resolveConflictRounds = ref(8);
const balanceLengthRounds = ref(3);
const minimizeCrossingsPasses = ref(3);
const saRestarts = ref(1);
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

// 首启默认 DC 信号预设（cell 2.0 / threshold 3.0）——原项目文档明确"默认 0.8/0.5 对 DC/HV 太严"，
// 默认值若用 probe_layer 原默认会让真实数据大量进人工（实测 1800 线 manual 1758）。
const presetName = ref<"custom" | "hv" | "full">("hv");

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
  if (typeof v.preset === "string") applyPreset(v.preset as "custom" | "hv" | "full");
  if (num("layers") !== undefined) layers.value = num("layers")!;
  if (num("width") !== undefined) width.value = num("width")!;
  if (num("clearance") !== undefined) clearance.value = num("clearance")!;
  if (str("method")) method.value = str("method")!;
  if (str("optimizer")) optimizer.value = str("optimizer")!;
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
  ];
  for (const [k, set] of map) {
    const n = num(k);
    if (n !== undefined) set(n);
  }
}

function applyPreset(p: "custom" | "hv" | "full"): void {
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
  }
}

/** 人工线占比过高提示（结果页）：超过 30% 大概率是拥塞阈值过严，建议 DC 信号预设 */
const manualRatio = computed(() => {
  if (!result.value) return 0;
  const s = result.value.summary;
  const total = s.wire_assigned_count + s.manual_route_net_count;
  return total > 0 ? s.manual_route_net_count / total : 0;
});

/* ---------- 内置文件浏览器（layer.listDir；Python 直读任意目录） ---------- */
const browserOpen = ref(false);
const browserMode = ref<"file" | "dir">("file");
const browserTitle = ref("");
const browserPath = ref("");
const browserEntries = ref<DirEntry[]>([]);
const browserBusy = ref(false);
const browserSelected = ref<string | null>(null);

async function openBrowser(mode: "file" | "dir", title: string, startPath: string): Promise<void> {
  browserMode.value = mode;
  browserTitle.value = title;
  browserOpen.value = true;
  browserSelected.value = null;
  await navigateBrowser(startPath);
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

/* ---------- 运行 ---------- */
const status = ref<Status>({ state: "idle" });
const jobId = ref<string | null>(null);
const runBusy = ref(false);
const progressEvents = ref<string[]>([]);
const runError = ref<string | null>(null);
const result = ref<JobResult | null>(null);
const pollTimer = ref<number | null>(null);
let lastLoggedProgress = "";

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
    if (s.jobId && s.jobId !== jobId.value) jobId.value = s.jobId;
    if (jobId.value) {
      try {
        result.value = (await props.api.call("layer.result", { jobId: jobId.value })) as JobResult;
        activeTab.value = "result";
        logEvent("分层完成");
        void props.api.call("layer.notifyDone", {
          title: "探针卡分层完成",
          body: `耗时 ${result.value.summary.elapsed_sec}s，硬冲突 ${result.value.summary.hard_conflict_count}`,
        });
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
const svgText = ref<string | null>(null);
const svgKind = ref("");
const svgBusy = ref(false);
const svgError = ref<string | null>(null);
const viewerText = ref<string | null>(null);
const viewerTitle = ref("");

/** SVG 文本 → base64 data URL（<img> 展示；宿主 CSP img-src 允许 data:）。
 * 不用 v-html 内联：matplotlib SVG 带 <?xml?>/<!DOCTYPE> 前缀，WebView2 解析不可靠。 */
function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

const svgUrl = computed(() => (svgText.value ? svgToDataUrl(svgText.value) : ""));

async function renderImage(kind: string): Promise<void> {
  if (!jobId.value) return;
  svgBusy.value = true;
  svgText.value = null;
  svgError.value = null;
  try {
    svgText.value = (await props.api.call("layer.render", { jobId: jobId.value, kind })) as string;
    svgKind.value = kind;
  } catch (e) {
    svgText.value = null;
    svgError.value = `渲染失败: ${e}`;
    logEvent(svgError.value);
  } finally {
    svgBusy.value = false;
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

/* ---------- 初始化：恢复上次输入/预设 + 订阅状态变化 ---------- */
void (async () => {
  try {
    const r = (await props.api.call("layer.config", { action: "get" })) as {
      settings: Record<string, unknown>;
    };
    const s = r.settings;
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
  await refreshStatus();
  if (status.value.state === "running") startPolling();
  if (status.value.state === "done" && status.value.jobId) {
    jobId.value = status.value.jobId;
    try {
      result.value = (await props.api.call("layer.result", { jobId: jobId.value })) as JobResult;
    } catch {
      /* 结果已过期（重启进程后 jobs 丢失） */
    }
  }
})();

/* 轮询期间状态收敛（含 done/failed 分支，由 refreshStatus 内部调用） */
onBeforeUnmount(() => {
  stopPolling();
  offProgress();
  offDone();
});
</script>

<template>
  <div class="prl-ui">
    <!-- 页签 -->
    <nav class="prl-tabs" role="tablist">
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
          <p class="prl-hint">不在筛选文件里的 net 全部不要；筛选应均匀覆盖圆各扇区（只圈一个扇区会全挤圆心）</p>
        </div>
        <div class="prl-field">
          <label class="prl-label">输出目录（必填，强制指定）</label>
          <div class="prl-row">
            <input v-model="outDir" class="prl-input" placeholder="D:\...\out_demo" />
            <button class="prl-btn" @click="openBrowser('dir', '选择输出目录', '')">浏览</button>
          </div>
        </div>
        <div class="prl-field">
          <label class="prl-label">预设</label>
          <div class="prl-row">
            <select v-model="presetName" class="prl-input prl-select" @change="applyPreset(presetName)">
              <option value="custom">自定义</option>
              <option value="hv">DC 信号（cell 2.0 / threshold 3.0 / 4 层 / 0.2mm）</option>
              <option value="full">全量（不筛选）</option>
            </select>
          </div>
        </div>
        <div class="prl-grid3">
          <div class="prl-field">
            <label class="prl-label">层数（xlsx 输入）</label>
            <input v-model.number="layers" type="number" min="1" max="16" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">线宽 mm（HV/DC 0.2，AC 0.1）</label>
            <input v-model.number="width" type="number" step="0.05" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">线距 mm</label>
            <input v-model.number="clearance" type="number" step="0.05" class="prl-input" />
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
          </div>
          <div class="prl-field">
            <label class="prl-label">精修 optimizer</label>
            <select v-model="optimizer" class="prl-input prl-select">
              <option value="sa">sa（模拟退火，默认）</option>
              <option value="greedy">greedy（只贪心）</option>
              <option value="none">none（关精修）</option>
            </select>
          </div>
          <div class="prl-field">
            <label class="prl-label">迭代① 硬冲突微调轮数</label>
            <input v-model.number="resolveConflictRounds" type="number" min="0" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">迭代② 长短均衡轮数</label>
            <input v-model.number="balanceLengthRounds" type="number" min="0" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">迭代③ 贪心交叉轮数</label>
            <input v-model.number="minimizeCrossingsPasses" type="number" min="0" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">迭代④ SA 多起点（耗时 ×N）</label>
            <input v-model.number="saRestarts" type="number" min="1" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">扇区角 sector_angle_deg（360/45=8 扇区）</label>
            <input v-model.number="sectorAngleDeg" type="number" min="5" step="5" class="prl-input" />
          </div>
        </div>
      </div>

      <div class="prl-card">
        <div class="prl-card-head">
          <h3>SA 精修参数</h3>
        </div>
        <div class="prl-grid3">
          <div class="prl-field">
            <label class="prl-label">初始温度</label>
            <input v-model.number="saInitialTemp" type="number" step="0.5" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">降温系数</label>
            <input v-model.number="saCooling" type="number" step="0.0001" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">步数（0=自动 max(4000, 30×线数)）</label>
            <input v-model.number="saMaxSteps" type="number" min="0" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">交换移动占比</label>
            <input v-model.number="saSwapRatio" type="number" min="0" max="1" step="0.1" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">均衡护栏 slack</label>
            <input v-model.number="saBalanceSlack" type="number" min="1" step="0.1" class="prl-input" />
          </div>
        </div>
      </div>

      <div class="prl-card">
        <div class="prl-card-head">
          <h3>拥塞估计</h3>
        </div>
        <div class="prl-grid3">
          <div class="prl-field">
            <label class="prl-label">拥塞网格 cell mm（HV 用 2.0）</label>
            <input v-model.number="congestionGridCell" type="number" step="0.5" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">硬冲突阈值（HV 用 3.0）</label>
            <input v-model.number="congestionHardThreshold" type="number" step="0.1" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">层容量（勿 >1）</label>
            <input v-model.number="layerCapacity" type="number" step="0.05" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">容量利用率</label>
            <input v-model.number="capacityUtilization" type="number" min="0" max="1" step="0.1" class="prl-input" />
          </div>
          <div class="prl-field">
            <label class="prl-label">过孔预留比例</label>
            <input v-model.number="viaAreaCost" type="number" step="0.05" class="prl-input" />
          </div>
        </div>
        <p class="prl-hint">阈值越大层越少、人工线越多；参数未列出的字段用 probe_layer 默认值</p>
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
            <h3>各层统计（点击层查看 SVG 图）</h3>
            <div class="prl-actions prl-actions-inline">
              <button class="prl-btn" @click="showOverview">总览图</button>
              <button class="prl-btn" @click="showRose">玫瑰图</button>
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

        <div v-if="svgText || svgBusy || svgError" class="prl-card">
          <div class="prl-card-head">
            <h3>{{ svgKind }}（SVG，按需渲染）</h3>
            <span v-if="svgBusy" class="prl-meta">渲染中…（首次约 1.5s）</span>
          </div>
          <div v-if="svgError" class="prl-error" role="alert">{{ svgError }}</div>
          <div v-if="svgText" class="prl-svg"><img :src="svgUrl" alt="分层图" /></div>
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

    <!-- ═══ 文件浏览器弹层 ═══ -->
    <div v-if="browserOpen" class="prl-modal" @click.self="browserOpen = false">
      <div class="prl-modal-box">
        <div class="prl-card-head">
          <h3>{{ browserTitle }}</h3>
          <button class="prl-btn prl-btn-sm" @click="browserOpen = false">关闭</button>
        </div>
        <div class="prl-row prl-breadcrumb">
          <button class="prl-btn prl-btn-sm" @click="navigateBrowser('')">根（盘符）</button>
          <span class="prl-path">{{ browserPath || "（盘符列表）" }}</span>
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
  gap: var(--space-4);
  padding: var(--space-6);
  box-sizing: border-box;
  overflow-y: auto;
  min-height: 100%;
}
.prl-tabs {
  display: flex;
  gap: var(--space-1);
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--space-2);
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 2;
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
  flex: 1;
  min-width: 0;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  color: var(--fg);
  font-size: var(--text-sm);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.prl-input::placeholder { color: var(--fg-faint); }
.prl-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
}
.prl-select { flex: none; min-width: 220px; }
.prl-hint { margin: 0; font-size: var(--text-xs); color: var(--fg-faint); line-height: 1.6; }
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
.prl-svg { border: 1px solid var(--border); border-radius: var(--radius-md); background: #fff; overflow: auto; max-height: 520px; }
.prl-svg img { width: 100%; height: auto; display: block; }
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
  padding: var(--space-4);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2, 0 12px 40px rgba(0, 0, 0, 0.25));
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
