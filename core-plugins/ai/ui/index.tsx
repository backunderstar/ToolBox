// core-ai 插件自带前端（组件模式）：AI 整理视图（对话 + 预设动作 + 笔记问答轻量 RAG）。
// 依赖 React（构建进 IIFE）；宿主注入统一 api 桥；CSS 复用宿主全局样式
// （.ai-view/.view-header/.ai-body 等 class 在宿主 app.css 中，组件注入宿主 React 树内直接生效）。
// 命令面（全部经 api.call，本插件 core-ai）：
//   ai.chatStream { messages } —— 流式对话，增量经 ai-chunk 事件到达，流结束后 resolve
//   ai.chat { messages } —— 非流式，返回完整回复字符串（如 AI 摘要场景，本视图未使用）
// 跨插件：core-search search.query（RAG 检索）、core-notes notes.read（读取命中片段）。
import React, { useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/** 宿主注入的桥 API（PluginUiView 构造；只声明本组件用到的方法） */
interface PluginBridgeApi {
  pluginId: string;
  /** 调用插件命令：默认调本插件；指定 targetPluginId 可跨插件调用 */
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  /** 订阅 plugin-event（默认本插件；可指定 targetPluginId），返回取消函数 */
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  /** 宿主注入的上下文：vault 路径 + 本插件扩展字段（activePath / activeContent 为挂载时快照） */
  context: { vault: string | null } & Record<string, unknown>;
  /** 宿主导航（主窗口可用；浮窗等独立窗口为 undefined） */
  nav?: { go: (view: string) => void };
}

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

/** ai.chatStream 请求消息（与宿主 src/core/api.ts 的 ChatMessage 同构） */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** ai-chunk 事件载荷（core-ai 流式增量；经 api.on 过滤后直接收到 data） */
interface AiChunk {
  text: string;
}

/** core-search search.query 返回的命中（与宿主 SearchHit 同构） */
interface SearchHit {
  path: string;
  filename: string;
  snippet: string;
}

/* ---------------- 内联小图标（插件独立构建，不共享宿主 icons） ---------------- */

const svg = (children: React.ReactNode, size = 16) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);
/** 与宿主 src/components/icons.tsx 的 IconSparkle 同构（统一 1.6 描边） */
const IconSparkle = (p: { width?: number; height?: number }) =>
  svg(
    <>
      <path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
    </>,
    p.width ?? 26
  );

/* ---------------- 主组件 ---------------- */

export function AiPluginUi({ api }: { api: PluginBridgeApi }) {
  // 当前笔记上下文：宿主在挂载时注入快照（activePath / activeContent），直接当初始 state
  const [currentNote] = useState<string | null>(() => {
    const c = api.context.activeContent;
    return typeof c === "string" && c ? c : null;
  });
  const [noteName] = useState<string>(() => {
    const p = api.context.activePath;
    return typeof p === "string" && p ? p : "未打开笔记";
  });

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 防并发守卫：`busy` 是渲染闭包快照，连按回车时第二次调用仍读到 false
  // → 会并发发出重复请求、回复乱序。用 ref 做同步检查 + 立即置位。
  const busyRef = useRef(false);
  // 流式累积：正在生成的 assistant 消息索引 + 已收到的文本
  const streamRef = useRef<{ idx: number; text: string } | null>(null);
  // 累计消息数：流式事件用函数式 setEntries 更新，索引必须稳定
  const countRef = useRef(0);

  /** 从输入框当前 DOM 值发送（避免 React 状态异步导致的旧值闭包） */
  const sendFromInput = () => {
    const v = inputRef.current?.value ?? input;
    void runChat(v);
  };

  const push = (e: ChatEntry) => {
    setEntries((prev) => [...prev, e]);
    countRef.current += 1;
  };
  const scrollToBottom = () =>
    setTimeout(
      () => bottomRef.current?.scrollIntoView({ behavior: "smooth" }),
      50
    );

  /**
   * 流式对话公共流程：建占位 assistant 消息 → 订阅 ai-chunk 逐段累积 →
   * ai.chatStream 结束（或出错）后清理。调用方负责先 push user 消息并构造 messages。
   */
  const runChatStream = async (messages: ChatMessage[]) => {
    const idx = countRef.current;
    push({ role: "assistant", content: "" });
    streamRef.current = { idx, text: "" };
    let un: (() => void) | null = null;
    try {
      // api.on 已按本插件（core-ai）+ 事件名过滤，回调直接收到 { text }
      un = api.on("ai-chunk", (data) => {
        const s = streamRef.current;
        if (!s) return;
        s.text += (data as AiChunk).text ?? "";
        setEntries((prev) => {
          const next = [...prev];
          next[s.idx] = { role: "assistant", content: s.text };
          return next;
        });
        scrollToBottom();
      });
      // 流结束后 resolve（增量经 ai-chunk 事件先到达）
      await api.call("ai.chatStream", { messages });
    } catch (e) {
      const msg = String(e);
      const friendly = msg.includes("未配置 API Key")
        ? `${msg}\n\n请先到「设置 → AI 提供商」填写配置。`
        : msg;
      setEntries((prev) => {
        const next = [...prev];
        const s = streamRef.current;
        next[s?.idx ?? next.length - 1] = {
          role: "assistant",
          content: friendly,
          error: true,
        };
        return next;
      });
    } finally {
      un?.();
      streamRef.current = null;
      busyRef.current = false;
      setBusy(false);
      scrollToBottom();
    }
  };

  const runChat = async (userText: string) => {
    if (!userText.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setInput("");
    push({ role: "user", content: userText });
    scrollToBottom();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "你是 ToolBox 的个人工作助理。回答简洁、准确，使用中文。涉及用户笔记时基于提供的内容作答。",
      },
      // 只带最近 10 条对话历史，避免长会话触发上下文超限
      ...entries
        .filter((e) => !e.error)
        .slice(-10)
        .map((e): ChatMessage => ({ role: e.role, content: e.content })),
      { role: "user", content: userText },
    ];
    await runChatStream(messages);
  };

  /* 预设动作：基于当前笔记内容（挂载时快照） */
  const preset = (action: string) => {
    if (!currentNote) {
      push({
        role: "assistant",
        content: "请先在「笔记」中打开一篇笔记，再使用预设动作。",
        error: true,
      });
      return;
    }
    const snippet = currentNote.slice(0, 4000);
    const prompts: Record<string, string> = {
      summary: `请总结这篇笔记（《${noteName}》），输出 3-5 条要点。\n\n笔记内容：\n${snippet}`,
      outline: `请为这篇笔记（《${noteName}》）提取大纲结构。\n\n笔记内容：\n${snippet}`,
      polish: `请润色这篇笔记（《${noteName}》），保持原意，改进表达。只输出润色后的全文。\n\n笔记内容：\n${snippet}`,
    };
    void runChat(prompts[action] ?? action);
  };

  /* RAG：跨插件检索相关笔记片段作为上下文回答 */
  const askWithRag = async () => {
    const q = input.trim();
    if (!q || busyRef.current) return;
    if (!api.context.vault) {
      push({ role: "assistant", content: "请先选择工作区。", error: true });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    const question = q;
    setInput("");
    push({ role: "user", content: `（基于笔记检索）${question}` });
    scrollToBottom();
    try {
      // 跨插件：core-search 全文检索（含启用的搜索提供者），取前 3 个命中
      const hits = (await api.call(
        "search.query",
        { query: question },
        "core-search"
      )) as SearchHit[];
      const top = hits.slice(0, 3);
      const chunks: string[] = [];
      for (const h of top) {
        try {
          // 跨插件：core-notes 读取命中文件内容（最多 1500 字符）
          const text = (await api.call(
            "notes.read",
            { rel: h.path },
            "core-notes"
          )) as string;
          chunks.push(`【${h.path}】\n${text.slice(0, 1500)}`);
        } catch {
          /* 跳过读取失败 */
        }
      }
      const context =
        chunks.length > 0
          ? chunks.join("\n\n---\n\n")
          : "（未检索到相关笔记）";
      const messages: ChatMessage[] = [
        {
          role: "system",
          content:
            "你是 ToolBox 的笔记问答助手。基于下方检索到的笔记内容回答用户问题；若内容不足以回答，明确说明。",
        },
        { role: "user", content: `检索到的笔记内容：\n${context}\n\n问题：${question}` },
      ];
      await runChatStream(messages);
    } catch (e) {
      push({ role: "assistant", content: String(e), error: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
      scrollToBottom();
    }
  };

  return (
    <div className="ai-view">
      <header className="view-header">
        <div>
          <h1>AI 整理</h1>
          <p className="view-sub">
            对话、总结笔记、问答检索（需在设置页配置 AI 提供商）
          </p>
        </div>
        <div className="view-actions">
          {/* 宿主 nav 桥不可用时（如浮窗）隐藏跳转按钮 */}
          {api.nav && (
            <button className="btn btn-sm" onClick={() => api.nav?.go("settings")}>
              配置 AI
            </button>
          )}
        </div>
      </header>

      <div className="ai-body">
        <div className="ai-chat" aria-live="polite">
          {entries.length === 0 ? (
            <div className="ai-empty">
              <IconSparkle />
              <p>开始一段对话，或用下面的动作整理笔记</p>
              <p className="ai-hint">
                {currentNote
                  ? `当前上下文：${noteName}`
                  : "提示：打开一篇笔记后可用「总结 / 提炼 / 润色」"}
              </p>
            </div>
          ) : (
            entries.map((e, i) => (
              <div key={i} className={`ai-msg ai-msg-${e.role}${e.error ? " err" : ""}`}>
                <div className="ai-msg-role">{e.role === "user" ? "你" : "AI"}</div>
                <div className="ai-msg-content">
                  {e.content || (e.role === "assistant" ? "思考中…" : "")}
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div className="ai-actions">
          <div className="ai-presets">
            <button className="btn btn-sm" onClick={() => preset("summary")} disabled={!currentNote || busy}>
              总结当前笔记
            </button>
            <button className="btn btn-sm" onClick={() => preset("outline")} disabled={!currentNote || busy}>
              提炼大纲
            </button>
            <button className="btn btn-sm" onClick={() => preset("polish")} disabled={!currentNote || busy}>
              润色
            </button>
          </div>
          <div className="ai-input-row">
            <input
              ref={inputRef}
              className="ai-chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void runChat(input);
                }
              }}
              placeholder="提问，或输入问题后点「笔记问答」检索笔记回答…"
            />
            <button className="btn btn-sm" onClick={() => void askWithRag()} disabled={busy || !input.trim()}>
              笔记问答
            </button>
            <button className="btn btn-primary-ai" onClick={sendFromInput} disabled={busy || !input.trim()}>
              {busy ? "思考中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- 注册到全局（宿主 PluginUiView 注入后读取） ---- */
declare global {
  interface Window {
    __TB_PLUGIN_UI__?: Record<
      string,
      { mount: (el: HTMLElement, api: PluginBridgeApi) => void; unmount?: () => void }
    >;
  }
}

let root: Root | null = null;
window.__TB_PLUGIN_UI__ = window.__TB_PLUGIN_UI__ || {};
window.__TB_PLUGIN_UI__["core-ai"] = {
  mount(el, api) {
    root = createRoot(el);
    root.render(<AiPluginUi api={api} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
