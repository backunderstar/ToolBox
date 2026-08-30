/** 宿主注入的桥 API（只声明本插件用到的字段；完整字段见 ToolBox 插件开发指南 §2.3）。 */
export interface PluginBridgeApi {
  /** 本插件 id（宿主注入） */
  pluginId: string;
  /** 调用插件命令（默认本插件）→ 宿主统一路由（process → JSON-RPC） */
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  /** 订阅插件事件（默认只收本插件）→ plugin-event */
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  /** 宿主上下文快照：当前工作区路径等 */
  context: { vault: string | null } & Record<string, unknown>;
  /** 跨视图导航 */
  nav?: { go: (view: string) => void };
  /** 宿主能力 */
  host?: Record<string, unknown>;
}

/* ---- 本插件命令参数/返回类型 ---- */

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number | null;
}

export interface RunArgs {
  input: string;
  filter?: string;
  outDir: string;
  layers?: number;
  width?: number;
  clearance?: number;
  config?: Record<string, unknown>;
  /** 迭代参数（等价 CLI flags） */
  resolve_conflict_rounds?: number;
  balance_length_rounds?: number;
  minimize_crossings_passes?: number;
  sa_restarts?: number;
}

export interface RunResult {
  jobId: string;
}

export interface Status {
  state: "idle" | "running" | "done" | "failed" | "cancelled";
  jobId?: string | null;
  stage?: string;
  percent?: number;
  message?: string;
  error?: string | null;
}

export interface LayerSummary {
  layer: number;
  kind: string;
  wires: string[];
  nets: string[];
  soft_conflict_count: number;
  max_occupancy: number;
}

export interface JobResult {
  summary: {
    method: string;
    layer_count: number;
    wire_assigned_count: number;
    plane_net_count: number;
    hard_conflict_count: number;
    soft_conflict_count: number;
    manual_route_net_count: number;
    manual_route_nets: string[];
    iterations_used: number;
    warnings: string[];
    capacity_lower_bound: Record<string, number>;
    elapsed_sec: number;
  };
  outDir: string;
  files: string[];
}

export interface ProgressData {
  jobId: string;
  stage: string;
  percent: number;
  message: string;
}

export interface DoneData {
  jobId: string;
  summary: JobResult["summary"];
}
