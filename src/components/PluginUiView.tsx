import { useEffect, useRef, useState } from "react";
import { pluginsReadFile, searchAll } from "../core/api";
import { useVault } from "../core/vault";
import { useNav } from "../core/navigation";
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
  const nav = useNav();
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let scriptUn: (() => void) | null = null;
    let styleEl: HTMLStyleElement | null = null;
    const w = window as unknown as Record<string, unknown>;

    // 统一 api 桥（与 webview 插件同构：call → plugin_call / on → plugin-event）。
    // nav：宿主导航（插件界面可跨视图跳转/双向链接）；
    // context 扩展：宿主 vault 快照（AI 预设动作等需要"当前笔记"上下文）。
    // openNote 额外广播 tb:open-note（同 document CustomEvent + 挂载期标记）：
    // 目标视图是插件自带前端时（如 core-notes ui），它从标记/事件拿到要打开的笔记。
    const api: PluginBridgeApi = buildBridgeApi(pluginId, () => vault.path, {
      nav: {
        // ViewId 为字符串字面量联合，插件侧按 string 使用
        go: (view: string) => nav.go(view as Parameters<typeof nav.go>[0]),
        openNote: (rel) => {
          const w2 = window as unknown as Record<string, unknown>;
          w2.__TB_PENDING_NOTE__ = rel;
          window.dispatchEvent(new CustomEvent("tb:open-note", { detail: rel }));
          nav.openNote(rel);
        },
        openChecklist: (id) => nav.openChecklist(id),
      },
      context: {
        activePath: vault.activePath,
        activeContent: vault.content,
      },
      // 宿主能力：搜索迁回本体后插件界面经统一桥调用（含搜索提供者聚合）
      host: {
        search: (query: string) => {
          if (!vault.path) return Promise.reject(new Error("工作区未设置"));
          return searchAll(vault.path, query);
        },
      },
    });

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
