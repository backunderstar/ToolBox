import { reactive, watch } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { searchAll, vaultGet, vaultSet } from "./api";
import type { SearchHit } from "./api";

/**
 * 工作区（Vault）状态中心（M1，宿主侧唯一数据源）——Vue 3 模块级单例 store。
 *
 * - 职责：工作区路径 / 当前上下文快照（activePath+content，供插件 bridge
 *   context.vault 读取）/ 全局全文搜索（顶栏搜索）/ 操作反馈状态条（status）。
 * - 文件列表/读写/增删改是**宿主框架能力**（core::files 命令，api.fs*），
 *   业务插件经自身命令读写自己的数据文件；宿主不再持有全局文件树
 *   （笔记等业务视图均为插件自带前端，各自管理自己的数据）。
 * - 插件写文件后经 `tb:vault-active` 事件同步"当前上下文"回本层
 *   （context.activePath/activeContent 快照，供 AI 预设等跨插件读取）。
 *
 * 与 React 版的对应关系（迁移要点）：
 * - `stateRef`/`useCallback` 闭包过期问题在 Vue 中不复存在：`reactive` 代理
 *   对象在任何闭包里读取的都是最新值，直接读 `state` 即可。
 * - `useEffect` → `watch` / 模块级初始化；`useMemo` → `computed`。
 */

const SEARCH_DELAY = 300;

/** 调试模式：?mock=1 时在浏览器（无 Tauri）中也能渲染界面 */
const isMock = () => new URLSearchParams(window.location.search).has("mock");

/** 状态（对外经 useVault() 暴露；写操作走下方函数，组件不应直接改字段） */
const state = reactive({
  path: null as string | null,
  /** 当前上下文快照（插件 UI 经 tb:vault-active 同步；供插件 bridge context 读取） */
  activePath: null as string | null,
  content: "",
  query: "",
  results: null as SearchHit[] | null,
  searching: false,
  status: "就绪",
});

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;

const flash = (msg: string) => {
  state.status = msg;
};

async function pickVault(): Promise<void> {
  if (isMock()) return;
  try {
    const sel = (await open({
      directory: true,
      title: "选择工作区文件夹",
      // 已设置工作区时，对话框初始定位到当前工作区目录（否则落在系统默认/记忆位置）
      defaultPath: state.path ?? undefined,
    })) as string | null;
    if (!sel) return;
    await vaultSet(sel);
    state.path = sel;
    state.activePath = null;
    state.content = "";
    state.query = "";
    state.results = null;
    flash("工作区已切换");
  } catch (e) {
    flash(String(e));
  }
}

function setQuery(q: string): void {
  state.query = q;
}

/* 搜索：防抖调用 Rust 全文搜索；请求序号丢弃过期响应（快速输入时旧结果不覆盖新结果） */
watch(
  () => [state.path, state.query] as const,
  () => {
    if (!state.path || !state.query.trim()) {
      // 先递增序号使在途请求失效，再清空结果：否则已发出的 searchAll 响应仍会
      // 通过 seq 校验，把旧结果回填到已清空的搜索框下方。
      searchSeq++;
      state.results = null;
      state.searching = false;
      return;
    }
    state.searching = true;
    if (searchTimer) clearTimeout(searchTimer);
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      try {
        const r = await searchAll(state.path!, state.query);
        if (seq !== searchSeq) return; // 过期响应
        state.results = r;
      } catch (e) {
        if (seq !== searchSeq) return;
        // 失败要明确提示：静默清空会让用户误以为"没有结果"
        flash(`搜索失败: ${e}`);
        state.results = [];
      } finally {
        if (seq === searchSeq) state.searching = false;
      }
    }, SEARCH_DELAY);
  },
);

/* 插件 UI 经同 document 的 tb:vault-active 事件同步"当前上下文"回宿主
   （宿主 vault 不持有插件 UI 内部状态），使跨插件读取 context.activePath/
   activeContent 的插件拿到最新上下文 */
window.addEventListener("tb:vault-active", (e: Event) => {
  const detail = (e as CustomEvent<{ rel?: string; content?: string }>).detail;
  if (typeof detail?.rel === "string" && detail.rel) {
    state.activePath = detail.rel;
    if (typeof detail.content === "string") {
      state.content = detail.content;
    }
  }
});

/* 启动：读取已保存的工作区（mock 模式则用内置示例） */
async function initVault(): Promise<void> {
  if (isMock()) {
    state.path = "mock-vault";
    return;
  }
  try {
    const s = await vaultGet();
    if (!s.path) return;
    state.path = s.path;
  } catch (e) {
    flash(String(e));
  }
}
void initVault();

/** 内部共享（plugins.ts 等监听工作区切换） */
export { state as vaultState };

/** 组件入口：只读状态 + 操作函数。
 *  注意：state 是 reactive 对象，直接解构其字段会丢失响应性——组件里应
 *  保持 `const vault = useVault()` 后整体使用（vault.state.xxx）。 */
export function useVault() {
  return {
    state,
    pickVault,
    setQuery,
  };
}
