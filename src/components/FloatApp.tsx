import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pluginsReadFile, vaultGet, floatSetLocked } from "../core/api";
import { buildBridgeApi, injectPluginScript, type PluginBridgeApi } from "../core/pluginRuntime";
import "./float.css";

/**
 * 桌面半透明浮窗（快速工具）—— 插件自带前端加载器：
 * - 独立窗口（transparent + 无边框 + 桌面层不置顶），加载同一前端入口，按窗口 label 分流到这里
 * - **宿主统一外壳**：标题栏（拖拽区 + 位置锁定）+ 底部页签（待办 / 清单），
 *   插件只渲染内容区（core-todos / core-checklists 的自带前端，与主窗口 PluginUiView
 *   同一注入机制）；锁定时禁用拖拽与调整大小（todos 自绘标题栏已迁移到外壳，多插件共用）
 * - 插件不可用时显示错误兜底
 */
const TABS = [
  { id: "core-todos", label: "待办" },
  { id: "core-checklists", label: "清单" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function FloatApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("core-todos");
  const [locked, setLocked] = useState(() => {
    try {
      return localStorage.getItem("toolbox.float.locked") === "1";
    } catch {
      return false;
    }
  });

  /* 浮窗模式：body 背景透明（窗口自身 transparent，露出圆角外区域） */
  useEffect(() => {
    document.body.classList.add("float-mode");
    return () => document.body.classList.remove("float-mode");
  }, []);

  /* 读取当前工作区（无则插件内提示；切换后重建桥重新挂载） */
  useEffect(() => {
    let alive = true;
    vaultGet()
      .then((s) => {
        if (alive) setVaultPath(s.path);
      })
      .catch(() => {
        if (alive) setVaultPath(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  /* 主窗口切换工作区后 Rust 广播 vault-changed：浮窗据此重读，避免继续写旧工作区。
     初始读取在上方 effect（只跑一次），这里订阅变更事件增量更新。 */
  useEffect(() => {
    let un: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        // 竞态防护（与 vault.tsx 同型）：listen 是异步 promise，若组件在 resolve
        // 前卸载，直接赋值会留下永久监听器（cleanup 已跑过 un?.() 是 no-op）。
        // resolve 后检测 cancelled：已卸载则立即注销，未卸载才登记给 cleanup。
        const fn = await listen("vault-changed", () => {
          vaultGet()
            .then((s) => {
              if (!cancelled) setVaultPath(s.path);
            })
            .catch(() => {
              if (!cancelled) setVaultPath(null);
            });
        });
        if (cancelled) fn();
        else un = fn;
      } catch {
        /* 非 Tauri 环境（浏览器 mock）无事件总线，忽略 */
      }
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  /* 加载当前页签插件自带前端并挂载（统一桥） */
  useEffect(() => {
    let disposed = false;
    let scriptUn: (() => void) | null = null;
    let styleEl: HTMLStyleElement | null = null;
    const w = window as unknown as Record<string, unknown>;

    // 统一桥（call → plugin_call / on → plugin-event）
    const api: PluginBridgeApi = buildBridgeApi(tab, () => vaultPath);

    (async () => {
      try {
        // 1. 样式注入（Vite 提取的 style.css；无则跳过）
        try {
          const css = await pluginsReadFile(tab, "ui/style.css");
          if (disposed) return;
          styleEl = document.createElement("style");
          styleEl.textContent = css;
          document.head.appendChild(styleEl);
        } catch {
          /* 无样式文件 */
        }
        // 2. 注入入口 JS（Blob URL script，顶层副作用注册 UI）
        const code = await pluginsReadFile(tab, "ui/index.js");
        if (disposed) return;
        scriptUn = await injectPluginScript(code);
        if (disposed) return;
        // 3. 取注册表并挂载
        const reg = (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.[tab];
        if (!reg?.mount || !containerRef.current) {
          throw new Error("插件未注册界面（ui/index.js 缺少 __TB_PLUGIN_UI__ 注册）");
        }
        reg.mount(containerRef.current, api);
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    })();

    return () => {
      disposed = true;
      (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.[tab]?.unmount?.();
      scriptUn?.();
      styleEl?.remove();
    };
    // 页签/工作区变化时重建桥并重新挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, vaultPath]);

  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    try {
      localStorage.setItem("toolbox.float.locked", next ? "1" : "0");
    } catch {
      /* 忽略 */
    }
    floatSetLocked(next).catch(() => undefined);
  };

  // 锁定后禁用拖拽：不给标题栏加 data-tauri-drag-region（锁按钮除外，需可点击）
  const dragProps = locked ? {} : { "data-tauri-drag-region": true };

  return (
    <div className="float-window">
      {/* 宿主标题栏：拖拽区 + 快捷键提示 + 位置锁定（所有页签共用） */}
      <div className="float-titlebar" {...dragProps}>
        <span className="float-title" {...dragProps}>
          {TABS.find((t) => t.id === tab)?.label}
        </span>
        <span className="float-hotkey" title="全局快捷键 Alt+Q：显示/隐藏浮窗">
          Alt+Q
        </span>
        <button
          className={`float-lock${locked ? " on" : ""}`}
          title={locked ? "已锁定位置 —— 点击解锁（可拖拽/调整大小）" : "锁定位置（防误拖）"}
          aria-label={locked ? "解锁位置" : "锁定位置"}
          aria-pressed={locked}
          onClick={toggleLock}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </button>
      </div>

      {/* 插件内容区 */}
      {error ? (
        <div className="float-empty">
          插件界面加载失败
          <div style={{ fontSize: 11, marginTop: 4 }}>{error}</div>
        </div>
      ) : (
        <div
          ref={containerRef}
          style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
        />
      )}

      {/* 底部页签：待办 / 清单 */}
      <div className="float-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`float-tab${tab === t.id ? " on" : ""}`}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface UiRegistry {
  mount: (el: HTMLElement, api: PluginBridgeApi) => void;
  unmount?: () => void;
}
