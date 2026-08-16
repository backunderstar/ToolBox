import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { pluginCall, pluginsReadFile } from "../core/api";
import { useVault } from "../core/vault";

/** 注入给插件前端的桥 API（与插件 ui 的 PluginUiApi 契约一致） */
export interface PluginUiApi {
  pluginId: string;
  /** 调用插件命令（默认本插件；可指定 targetPluginId 跨插件调用） */
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  /** 订阅本插件的 plugin-event（返回取消函数） */
  on: (event: string, cb: (data: unknown) => void) => () => void;
  context: { vault: string | null };
}

interface UiRegistry {
  mount: (el: HTMLElement, api: PluginUiApi) => void;
  unmount?: () => void;
}

/**
 * 插件自带前端容器（组件模式）：
 * 读插件目录 ui/index.js（自包含 IIFE，React 已打进产物）→ Blob URL <script> 注入
 * （与 webview 插件同机制，CSP script-src blob: 允许）→ 插件注册到
 * window.__TB_PLUGIN_UI__[pluginId] → 本组件把 api 桥注入并挂载到容器。
 */
export function PluginUiView({ pluginId }: { pluginId: string }) {
  const vault = useVault();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let script: HTMLScriptElement | null = null;
    let styleEl: HTMLStyleElement | null = null;
    const w = window as unknown as Record<string, unknown>;

    const api: PluginUiApi = {
      pluginId,
      call: (command, args, targetPluginId) => {
        const v = vault.path;
        if (!v) return Promise.reject(new Error("工作区未设置"));
        // args 缺省 {}（undefined 会被 invoke 序列化丢弃导致 Rust 侧缺参）
        return pluginCall(v, targetPluginId ?? pluginId, command, args ?? {});
      },
      on: (event, cb) => {
        listen<{ pluginId: string; event: string; data: unknown }>("plugin-event", (e) => {
          if (e.payload.pluginId === pluginId && e.payload.event === event) {
            cb(e.payload.data);
          }
        })
          .then((fn) => (unlisten = fn))
          .catch(() => undefined);
        return () => unlisten?.();
      },
      context: { vault: vault.path },
    };

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
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        try {
          await new Promise<void>((resolve, reject) => {
            script = document.createElement("script");
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("插件界面脚本加载失败"));
            document.head.appendChild(script);
          });
        } finally {
          URL.revokeObjectURL(url);
        }
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
      script?.remove();
      styleEl?.remove();
      unlisten?.();
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
