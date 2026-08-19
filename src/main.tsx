import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { applyTheme, getInitialTheme } from "./themes/themes";

// 渲染前应用初始主题（含原生标题栏同步），避免首帧闪烁
applyTheme(getInitialTheme());

/* ---- 调试通道：把前端错误转发到 Rust 终端（pnpm tauri dev 输出可见） ---- */
interface EvtLike {
  message?: unknown;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: unknown;
  type?: string;
}

function toText(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
  }
  if (typeof arg === "string") return arg;
  if (arg instanceof Event) {
    const ev = arg as Event & EvtLike;
    const detail = ev.error !== undefined ? ` error=${toText(ev.error)}` : "";
    return `Event(${ev.type}) message=${String(ev.message ?? "")} src=${ev.filename ?? ""}:${ev.lineno ?? ""}${detail}`;
  }
  if (arg && typeof arg === "object") {
    const m = (arg as EvtLike).message;
    if (typeof m === "string") {
      return `${String((arg as { name?: unknown }).name ?? "")}: ${m}`;
    }
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  origError(...args);
  const msg = args.map(toText).join(" | ");
  invoke("log_console", { msg }).catch(() => {
    /* 浏览器预览时无 Tauri，忽略 */
  });
};

window.addEventListener("error", (e) => {
  console.error(
    `[global-error] type=${e.type} message=${e.message} src=${e.filename}:${e.lineno}:${e.colno}`,
    e.error,
  );
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandled-rejection]", e.reason);
});

/* ---- 外链拦截（用户决策）：笔记/插件界面里的 http(s) 链接点击不在应用内导航，
   改走系统默认浏览器（opener 插件）——防误导航离开应用、防钓鱼面。
   用 document 级事件委托（捕获阶段），覆盖宿主视图与插件自带前端；
   Vditor 渲染的链接同样冒泡到这里。 ---- */
document.addEventListener(
  "click",
  (e) => {
    const target = e.target as HTMLElement | null;
    const a = target?.closest?.("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || !/^https?:/i.test(href)) return;
    // 忽略 target=_blank 的链接（新窗口意图，交给浏览器默认行为）
    if (a.target === "_blank") return;
    e.preventDefault();
    void import("@tauri-apps/plugin-opener").then((m) =>
      m.openUrl(href).catch(() => {
        window.open(href, "_blank");
      }),
    );
  },
  true,
);

// 捕获阶段监听：抓取 script/link 等资源加载失败的真实 URL
// （资源错误不冒泡，但 window 捕获阶段能收到）
window.addEventListener(
  "error",
  (e) => {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    let src: string | undefined;
    if (tag === "LINK") {
      src = (t as HTMLLinkElement).href;
    } else if (t instanceof HTMLScriptElement || t instanceof HTMLImageElement) {
      src = t.src;
    }
    if (tag === "SCRIPT" || tag === "LINK" || tag === "IMG") {
      console.error(`[resource-error] <${tag}> ${src ?? "(无地址)"}`);
    }
  },
  true,
);

// 启动 3 秒后：dump 加载失败的资源条目（responseStatus=0 表示失败）。
// 仅 dev 调试用：生产构建不执行，避免向用户终端输出无意义的 [failed-resources] 日志。
if (import.meta.env.DEV) {
  setTimeout(() => {
    try {
      const failed = performance
        .getEntriesByType("resource")
        .filter((r) => (r as PerformanceResourceTiming).responseStatus === 0)
        .map((r) => r.name);
      if (failed.length > 0) {
        console.error(`[failed-resources] ${failed.length} 个:\n${failed.join("\n")}`);
      } else {
        console.error("[failed-resources] 无失败资源");
      }
    } catch {
      /* 忽略 */
    }
  }, 3000);
}

// 注意：不使用 StrictMode——Vditor 初始化是异步的，
// StrictMode 的开发期双挂载会导致两个实例在同一容器上竞争（白屏）。
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
