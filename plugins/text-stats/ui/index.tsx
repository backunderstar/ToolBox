// text-stats 插件自带前端（组件模式）：文本统计工具页。
// 逻辑在界面内本地实现——webview 插件的命令注册（main.js 的 registerCommand）
// 供插件页"命令试用台"调用；plugin_call 只分发 native/process，界面内直接算即可
// （见 docs/插件开发指南.md §0.1 运行时对比与 §2.4）。
// 宿主注入 api 桥；样式复用宿主全局 CSS（class 随主题自适应）。
import React, { useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/** 宿主注入的桥 API（只声明用到的字段） */
interface PluginBridgeApi {
  pluginId: string;
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
  // 实时统计（useMemo：输入变化即重算，无需按钮）
  const stats: TextStats = useMemo(() => {
    const trimmed = text.trim();
    return {
      chars: [...text].length,
      words: trimmed ? trimmed.split(/\s+/).length : 0,
      lines: text.length === 0 ? 0 : text.split("\n").length,
      paragraphs: trimmed ? text.split(/\n\s*\n/).length : 0,
    };
  }, [text]);

  const Row = ({ label, value }: { label: string; value: number }) => (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );

  return (
    <div className="view-header">
      <div>
        <h1>文本统计</h1>
        <p className="view-sub">
          {api.context.vault ? `工作区: ${api.context.vault}` : "尚未选择工作区（本工具无需工作区）"}
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
          <Row label="字符数" value={stats.chars} />
          <Row label="词数" value={stats.words} />
          <Row label="行数" value={stats.lines} />
          <Row label="段落数" value={stats.paragraphs} />
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
