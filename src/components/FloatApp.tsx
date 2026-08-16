import { useEffect, useRef, useState } from "react";
import { pluginsReadFile, vaultGet, floatSetLocked } from "../core/api";
import {
  buildBridgeApi,
  injectPluginScript,
  type PluginBridgeApi,
} from "../core/pluginRuntime";
import "./float.css";

/**
 * 桌面半透明浮窗（快速待办）—— 插件自带前端加载器：
 * - 独立窗口（transparent + 无边框 + 桌面层不置顶），加载同一前端入口，按窗口 label 分流到这里
 * - 本组件只保留窗口外壳：float-mode body（透明背景）+ 加载 core-todos 插件自带前端
 *   （ui/index.js，与主窗口 PluginUiView 同一注入机制）并挂载到容器
 * - 浮窗内容（标题栏/输入/列表/锁定）全部在插件内；插件不可用时报错兜底
 * - 数据 = vault/data/todos/todos.json（core-todos 插件，事件同步）
 */
export function FloatApp() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  /* 加载 core-todos 插件自带前端并挂载（统一桥 + 浮窗专属 floatSetLocked） */
  useEffect(() => {
    let disposed = false;
    let scriptUn: (() => void) | null = null;
    let styleEl: HTMLStyleElement | null = null;
    const w = window as unknown as Record<string, unknown>;

    // 统一桥（call → plugin_call / on → plugin-event）+ 浮窗专属宿主命令
    const api: PluginBridgeApi & {
      floatSetLocked: (locked: boolean) => Promise<void>;
    } = {
      ...buildBridgeApi("core-todos", () => vaultPath),
      floatSetLocked: (locked: boolean) => floatSetLocked(locked),
    };

    (async () => {
      try {
        // 1. 样式注入（Vite 提取的 style.css；无则跳过）
        try {
          const css = await pluginsReadFile("core-todos", "ui/style.css");
          if (disposed) return;
          styleEl = document.createElement("style");
          styleEl.textContent = css;
          document.head.appendChild(styleEl);
        } catch {
          /* 无样式文件 */
        }
        // 2. 注入入口 JS（Blob URL script，顶层副作用注册 UI）
        const code = await pluginsReadFile("core-todos", "ui/index.js");
        if (disposed) return;
        scriptUn = await injectPluginScript(code);
        if (disposed) return;
        // 3. 取注册表并挂载
        const reg = (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.["core-todos"];
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
      (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.["core-todos"]?.unmount?.();
      scriptUn?.();
      styleEl?.remove();
    };
    // vaultPath 变化（工作区切换）时重建桥并重新挂载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath]);

  return (
    <div className="float-window">
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
    </div>
  );
}

interface UiRegistry {
  mount: (el: HTMLElement, api: PluginBridgeApi) => void;
  unmount?: () => void;
}
