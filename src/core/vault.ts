import { reactive, watch } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import { searchAll, workspaceCreate, workspaceGet, workspaceSetRoot, workspaceSwitch } from "./api";
import type { SearchHit, WorkspaceItem } from "./api";

/**
 * 工作区（数据根模型，2026-09 用户重定义）状态中心——Vue 3 模块级单例 store。
 *
 * - **数据根目录**（state.root）：所有数据的家（自选，如 D:\ToolBoxData）。
 *   根下按约定组织：Project/（工作区）、Plugin/、Config/；宿主只管理 Project/。
 * - **工作区** = 数据根/Project/<名称>（state.items）；state.path = 当前生效
 *   工作区绝对路径。日常选定工作区后，搜索/备份/文件/插件都作用于当前工作区。
 * - 未配置数据根（首启）→ state.configured=false → App 显示引导页。
 * - 插件写文件后经 `tb:vault-active` 事件同步"当前上下文"回本层。
 */

const SEARCH_DELAY = 300;

/** 调试模式：?mock=1 时在浏览器（无 Tauri）中也能渲染界面 */
const isMock = () => new URLSearchParams(window.location.search).has("mock");

/** 状态（对外经 useVault() 暴露；写操作走下方函数，组件不应直接改字段） */
const state = reactive({
  /** 数据根目录（null = 未配置，显示引导页） */
  root: null as string | null,
  /** 当前工作区名（数据根/Project/ 下） */
  current: null as string | null,
  /** 当前生效工作区绝对路径 */
  path: null as string | null,
  /** 数据根 Project/ 下的工作区（项目文件夹）列表 */
  items: [] as WorkspaceItem[],
  /** 当前上下文快照（插件 UI 经 tb:vault-active 同步；供插件 bridge context 读取） */
  activePath: null as string | null,
  content: "",
  query: "",
  results: null as SearchHit[] | null,
  searching: false,
  status: "就绪",
});

/** 数据根是否已配置（引导页判断） */
const configured = () => !!state.root;

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;

const flash = (msg: string) => {
  state.status = msg;
};

/** 应用 Rust 侧返回的工作区信息到本地状态（path 变化会触发搜索 watch 重查） */
function applyWorkspace(r: {
  root: string | null;
  current: string | null;
  vault: string | null;
  items: WorkspaceItem[];
}): void {
  state.root = r.root;
  state.current = r.current;
  state.items = r.items ?? [];
  if (r.vault !== state.path) {
    state.path = r.vault;
    state.activePath = null;
    state.content = "";
    state.query = "";
    state.results = null;
  }
}

/** 切换当前工作区（name 为 数据根/Project/ 下的子目录名） */
async function switchWorkspace(name: string): Promise<void> {
  try {
    applyWorkspace(await workspaceSwitch(name));
    flash(`已切换到工作区「${name}」`);
  } catch (e) {
    flash(String(e));
  }
}

/** 新建工作区（数据根/Project/ 下创建文件夹并切换为当前；成功返回 true） */
async function createWorkspace(name: string): Promise<boolean> {
  try {
    applyWorkspace(await workspaceCreate(name));
    flash(`已创建工作区「${name}」`);
    return true;
  } catch (e) {
    flash(String(e));
    return false;
  }
}

/** 设置数据根目录（引导页/设置页调用：选择文件夹后，Project/ 下子目录即工作区） */
async function setWorkspaceRoot(dir: string): Promise<void> {
  try {
    const r = await workspaceSetRoot(dir);
    applyWorkspace(r);
    flash(
      r.current
        ? `数据根已设置，当前工作区「${r.current}」`
        : "数据根已设置（Project/ 下暂无工作区，新建文件夹即工作区）",
    );
  } catch (e) {
    flash(String(e));
  }
}

/** 选择并设置数据根目录（文件夹选择器） */
async function pickWorkspaceRoot(): Promise<void> {
  if (isMock()) return;
  try {
    const sel = (await open({
      directory: true,
      title: "选择数据根目录（所有数据的家；根下 Project/ 存放工作区）",
      defaultPath: state.root ?? undefined,
    })) as string | null;
    if (!sel) return;
    await setWorkspaceRoot(sel);
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

/* 插件 UI 经同 document 的 tb:vault-active 事件同步"当前上下文"回宿主 */
window.addEventListener("tb:vault-active", (e: Event) => {
  const detail = (e as CustomEvent<{ rel?: string; content?: string }>).detail;
  if (typeof detail?.rel === "string" && detail.rel) {
    state.activePath = detail.rel;
    if (typeof detail.content === "string") {
      state.content = detail.content;
    }
  }
});

/* 启动：读取已保存的数据根（mock 模式用内置示例） */
async function initVault(): Promise<void> {
  if (isMock()) {
    state.root = "mock-root";
    state.path = "mock-vault";
    return;
  }
  try {
    const r = await workspaceGet();
    applyWorkspace(r);
  } catch (e) {
    flash(String(e));
  }
}
void initVault();

/** 内部共享（plugins.ts 等监听工作区切换） */
export { state as vaultState };

/** 组件入口：只读状态 + 操作函数。 */
export function useVault() {
  return {
    state,
    configured,
    pickWorkspaceRoot,
    setWorkspaceRoot,
    createWorkspace,
    switchWorkspace,
    setQuery,
  };
}
