import { useEffect, useRef, useState } from "react";
import { pluginsReadFile } from "../core/api";
import { useVault } from "../core/vault";
import {
  buildBridgeApi,
  injectPluginScript,
  type PluginBridgeApi,
} from "../core/pluginRuntime";

interface UiRegistry {
  mount: (el: HTMLElement, api: PluginBridgeApi) => void;
  unmount?: () => void;
}

/**
 * 插件自带前端容器（组件模式）：
 * 读插件目录 ui/index.js（自包含 IIFE，React 已打进产物）→ Blob URL <script> 注入
 * （公共运行时 injectPluginScript，与 webview 插件同机制）→ 插件注册到
 * window.__TB_PLUGIN_UI__[pluginId] → 本组件把统一 api 桥注入并挂载到容器。
 */
export function PluginUiView({ pluginId }: { pluginId: string }) {
  const vault = useVault();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let scriptUn: (() => void) | null = null;
    let styleEl: HTMLStyleElement | null = null;
    const w = window as unknown as Record<string, unknown>;

    // 统一 api 桥（与 webview 插件同构：call → plugin_call / on → plugin-event）
    const api: PluginBridgeApi = buildBridgeApi(pluginId, () => vault.path);

    (async () => {
      try {
        // 1. 样式注入（Vite 提取的 style.css；无则跳过）
        try {
          const css = await pluginsReadFile(pluginId, "ui/style.css");
          if (disposed) return;
          styleEl = document.createElement("style");
          styleEl.textContent = css;
          document.head.appendChild(styleEl);
        } catch {
          /* 无样式文件 */
        }
        // 2. 注入入口 JS（Blob URL script，顶层副作用注册 UI）
        const code = await pluginsReadFile(pluginId, "ui/index.js");
        if (disposed) return;
        scriptUn = await injectPluginScript(code);
        if (disposed) return;
        // 3. 取注册表并挂载
        const reg = (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.[pluginId];
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
      (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.[pluginId]?.unmount?.();
      scriptUn?.();
      styleEl?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId, vault.path]);

  return (
    <div className="plugin-ui-view">
      <div ref={containerRef} className="plugin-ui-container" />
      {error && <div className="empty-state plugin-error">{error}</div>}
    </div>
  );
}
