import { reactive, watch } from "vue";
import { open } from "@tauri-apps/plugin-dialog";
import {
  fsCreate,
  fsDelete,
  fsList,
  fsRead,
  fsRename,
  fsWrite,
  searchAll,
  vaultGet,
  vaultSet,
} from "./api";
import type { FileEntry, SearchHit } from "./api";

/**
 * 工作区（Vault）状态中心（M1，宿主侧唯一数据源）——Vue 3 模块级单例 store。
 *
 * 与 React 版的对应关系（迁移要点）：
 * - `stateRef`/`useCallback` 闭包过期问题在 Vue 中不复存在：`reactive` 代理
 *   对象在任何闭包里读取的都是最新值，直接读 `state` 即可。
 * - `useEffect` → `watch` / 模块级初始化；`useMemo` → `computed`。
 * - 自动保存 / 搜索防抖 / 竞态防护（searchSeq）逻辑 1:1 保留。
 *
 * - 职责：工作区路径 / 文件树 / 当前笔记（activePath+content）/ 脏标记 /
 *   全局全文搜索（顶栏搜索）/ 操作反馈状态条（status）。
 * - 文件操作（列表/读写/增删改）经 core-notes 原生插件（plugin_call → DLL）；
 *   全局搜索经宿主 search_all（FTS + 搜索提供者聚合）。
 * - 笔记视图已迁到 core-notes 插件自带前端（PluginUiView）：插件侧通过
 *   `tb:vault-active` 事件同步"当前打开的笔记"回本层；插件写文件后推
 *   `notes-changed` 事件，本层监听刷新文件树。
 */

const AUTOSAVE_DELAY = 800;
const SEARCH_DELAY = 300;

/** 调试模式：?mock=1 时在浏览器（无 Tauri）中也能渲染界面 */
const isMock = () => new URLSearchParams(window.location.search).has("mock");

/** 状态（对外经 useVault() 暴露；写操作走下方函数，组件不应直接改字段） */
const state = reactive({
  path: null as string | null,
  files: [] as FileEntry[],
  activePath: null as string | null,
  content: "",
  dirty: false,
  query: "",
  results: null as SearchHit[] | null,
  searching: false,
  status: "就绪",
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;

const flash = (msg: string) => {
  state.status = msg;
};

async function refresh(vaultPath?: string): Promise<void> {
  const p = vaultPath ?? state.path;
  if (!p) return;
  try {
    state.files = await fsList(p);
  } catch (e) {
    flash(String(e));
  }
}

async function save(manual = false): Promise<void> {
  if (isMock()) {
    state.dirty = false;
    return;
  }
  const { path: p, activePath: ap, content: c } = state;
  if (!p || !ap) return;
  try {
    await fsWrite(p, ap, c);
    // 写盘期间若有新输入（content 已变化），不清 dirty，交给新定时器保存
    if (state.content === c) {
      state.dirty = false;
      if (manual) flash(`已保存 ${ap}`);
    } else if (manual) {
      flash("保存中检测到新输入，稍后自动保存");
    }
  } catch (e) {
    flash(String(e));
  }
}

async function openFile(rel: string): Promise<void> {
  if (isMock()) return;
  const p = state.path;
  if (!p) return;
  if (state.dirty) await save(false);
  // 快照打开前的内容：fsRead 是异步 IPC，若期间用户继续输入，
  // 直接覆盖会用旧内容覆盖新输入 → 静默丢字
  const openingContent = state.content;
  try {
    const text = await fsRead(p, rel);
    if (state.content !== openingContent) {
      flash("读取期间有新的输入，已取消切换");
      return;
    }
    state.activePath = rel;
    state.content = text;
    state.dirty = false;
  } catch (e) {
    flash(String(e));
  }
}

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
    // 切换前把未保存内容落盘（写入旧工作区），防止防抖窗口内的输入丢失
    if (state.dirty) await save(false);
    await vaultSet(sel);
    state.path = sel;
    state.activePath = null;
    state.content = "";
    state.dirty = false;
    await refresh(sel);
    flash("工作区已切换");
  } catch (e) {
    flash(String(e));
  }
}

async function newNote(): Promise<void> {
  if (isMock()) return;
  const p = state.path;
  if (!p) return;
  // 时间戳到毫秒（17 位 YYYYMMDDHHmmssSSS）：秒级粒度连续新建会撞名
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 17);
  // 笔记统一存放在工作区 notes/ 目录下
  const rel = `notes/笔记-${ts}.md`;
  try {
    await fsCreate(p, rel);
    await refresh(p);
    await openFile(rel);
  } catch (e) {
    flash(String(e));
  }
}

async function removeFile(rel: string): Promise<void> {
  if (isMock()) return;
  const p = state.path;
  if (!p) return;
  try {
    await fsDelete(p, rel);
    await refresh(p);
    if (state.activePath === rel) {
      state.activePath = null;
      state.content = "";
      state.dirty = false;
    }
    flash(`已删除 ${rel}`);
  } catch (e) {
    flash(String(e));
  }
}

async function renameFile(from: string, to: string): Promise<void> {
  if (isMock()) return;
  const p = state.path;
  if (!p || from === to) return;
  // 前端校验（后端也会兜底）：非法字符 / 目标已存在
  const name = to.slice(to.lastIndexOf("/") + 1);
  if (/[\\/:*?"<>|]/.test(name)) {
    flash(`文件名包含非法字符: ${name}`);
    return;
  }
  if (state.files.some((f) => f.path === to && f.path !== from)) {
    flash(`同名文件已存在: ${to}`);
    return;
  }
  try {
    await fsRename(p, from, to);
    await refresh(p);
    if (state.activePath === from) state.activePath = to;
    flash(`已重命名 ${from} → ${to}`);
  } catch (e) {
    flash(String(e));
  }
}

function updateContent(text: string): void {
  state.content = text;
  state.dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(false), AUTOSAVE_DELAY);
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

/* 插件自带前端（core-notes ui）写文件后推送 notes-changed：
   本层监听刷新文件列表，保证顶栏/状态栏/其他视图读到一致的文件树。
   模块级单例：监听随 app 生命周期，无卸载竞态（与组件级 useTauriListen 不同）。 */
void import("@tauri-apps/api/event").then((m) =>
  m
    .listen<{ pluginId: string; event: string }>("plugin-event", (e) => {
      if (e.payload.pluginId === "core-notes" && e.payload.event === "notes-changed") {
        void refresh();
      }
    })
    .catch(() => {
      /* 非 Tauri 环境（浏览器 mock）无事件总线，忽略 */
    }),
);

/* 笔记视图为插件自带前端时，插件通过同 document 的 tb:vault-active 事件
   同步当前打开的笔记（宿主 vault 不持有插件 UI 内部状态），
   使 AI 预设动作等读取 context.activePath/activeContent 的插件拿到最新上下文 */
window.addEventListener("tb:vault-active", (e: Event) => {
  const detail = (e as CustomEvent<{ rel?: string; content?: string }>).detail;
  if (typeof detail?.rel === "string" && detail.rel) {
    state.activePath = detail.rel;
    if (typeof detail.content === "string") {
      // 清掉在途自动保存定时器：插件已把内容写盘并广播（dirty 置 false），
      // 若还留着排定的旧保存，到期会用旧 content 覆盖插件刚写入的内容
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      state.content = detail.content;
    }
    state.dirty = false;
  }
});

/* 启动：读取已保存的工作区（mock 模式则用内置示例） */
async function initVault(): Promise<void> {
  if (isMock()) {
    state.path = "mock-vault";
    state.files = [{ name: "示例笔记.md", path: "notes/示例笔记.md", isDir: false, size: null }];
    state.activePath = "notes/示例笔记.md";
    state.content =
      "# 示例笔记\n\n欢迎使用 ToolBox。\n\n- 列表一\n- 列表二\n\n```js\nconsole.log(1)\n```\n\n> 引用内容\n\n**加粗** 与 $E=mc^2$";
    return;
  }
  try {
    const s = await vaultGet();
    if (!s.path) return;
    state.path = s.path;
    await refresh(s.path);
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
    refresh,
    openFile,
    save,
    newNote,
    removeFile,
    renameFile,
    setQuery,
    updateContent,
  };
}
