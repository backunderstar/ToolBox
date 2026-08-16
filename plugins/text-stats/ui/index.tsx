// text-stats 插件自带前端（组件模式）：文本统计工具页。
// 演示"UI 经 api.call 调自己的命令"：统计逻辑在 main.js 的 registerCommand
// （analyze）里，UI 只负责输入与展示——api.call 命中 webview 本地命令注册表
// 本地执行（见 pluginRuntime.ts 的 localCommands 注释；plugin_call 只路由
// native/process，webview 命令靠前端本地表）。宿主注入 api 桥；样式复用宿主全局 CSS。
import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/** 宿主注入的桥 API（只声明用到的字段） */
interface PluginBridgeApi {
  pluginId: string;
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  context: { vault: string | null };
}

interface TextStats {
  chars: number;
  words: number;
  lines: number;
  paragraphs: number;
}

export function TextStatsUi({ api }: { api: PluginBridgeApi }) {
  const [text, setText] = useState("");
  const [stats, setStats] = useState<TextStats | null>(null);
  const seqRef = useRef(0);

  // 防抖（400ms）调 analyze 命令：真实走"UI → api.call → 本地注册表 → 命令"
  useEffect(() => {
    const seq = ++seqRef.current;
    if (!text.trim()) {
      setStats(null);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .call("analyze", { text })
        .then((r) => {
          if (seq === seqRef.current) setStats(r as TextStats);
        })
        .catch((e) => console.error("[text-stats] analyze 失败", e));
    }, 400);
    return () => clearTimeout(timer);
  }, [text, api]);

  const Row = ({ label, value }: { label: string; value: number }) => (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value ?? "…"}</span>
    </div>
  );

  return (
    <div className="view-header">
      <div>
        <h1>文本统计</h1>
        <p className="view-sub">
          {api.context.vault
            ? `工作区: ${api.context.vault}`
            : "尚未选择工作区（本工具无需工作区）"}
          {" · 统计逻辑在命令 analyze（UI 经 api.call 调用）"}
        </p>
      </div>
      <div className="text-stats-panel">
        <textarea
          className="text-stats-input"
          placeholder="在此粘贴或输入文本，统计结果实时更新…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <div className="text-stats-result">
          <Row label="字符数" value={stats?.chars ?? 0} />
          <Row label="词数" value={stats?.words ?? 0} />
          <Row label="行数" value={stats?.lines ?? 0} />
          <Row label="段落数" value={stats?.paragraphs ?? 0} />
        </div>
      </div>
    </div>
  );
}

/** 自包含 IIFE 入口：注册到宿主注册表，宿主 PluginUiView 挂载时调用 */
declare global {
  interface Window {
    __TB_PLUGIN_UI__: Record<
      string,
      { mount(el: HTMLElement, api: PluginBridgeApi): void; unmount?(): void }
    >;
  }
}
window.__TB_PLUGIN_UI__ = window.__TB_PLUGIN_UI__ || {};
window.__TB_PLUGIN_UI__["text-stats"] = {
  mount: (el, api) => {
    const root: Root = createRoot(el);
    root.render(<TextStatsUi api={api} />);
    window.__TB_PLUGIN_UI__["text-stats"].unmount = () => root.unmount();
  },
};
