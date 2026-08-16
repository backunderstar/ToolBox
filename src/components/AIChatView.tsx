import { useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVault } from "../core/vault";
import { useNav } from "../core/navigation";
import { aiChatStream, searchAll, fsRead } from "../core/api";
import type { AiChunk, ChatMessage } from "../core/api";
import { IconSparkle } from "./icons";

/**
 * AI 整理视图（M6）：对话面板 + 预设动作 + 笔记问答（轻量 RAG）。
 * 无 API Key 时引导到设置页。
 */

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

export function AIChatView() {
  const vault = useVault();
  const nav = useNav();
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
   * 流式对话公共流程：建占位 assistant 消息 → 监听 ai-chunk 逐段累积 →
   * 等待 ai-done 结束事件后收尾。调用方负责先 push user 消息并构造 messages。
   *
   * 注意：`ai.chatStream` 现在**立即返回**（core-ai 把流式请求派发到独立线程，
   * 避免宿主 tokio 线程 block_on 嵌套 panic），流结束/失败改由 `ai-done`
   * 事件（`{ok, error?}`）通知，不再以 invoke resolve 为准。
   */
  const runChatStream = async (messages: ChatMessage[]) => {
    const idx = countRef.current;
    push({ role: "assistant", content: "" });
    streamRef.current = { idx, text: "" };
    let un: (() => void) | null = null;
    let unDone: (() => void) | null = null;
    try {
      un = await listen<{ pluginId: string; event: string; data: AiChunk }>(
        "plugin-event",
        (e) => {
          // core-ai 插件流式增量经事件桥转发（与 ai-chunk 同载荷）
          if (e.payload.pluginId !== "core-ai" || e.payload.event !== "ai-chunk") return;
          const s = streamRef.current;
          if (!s) return;
          s.text += e.payload.data.text;
          setEntries((prev) => {
            const next = [...prev];
            next[s.idx] = { role: "assistant", content: s.text };
            return next;
          });
          scrollToBottom();
        }
      );
      // 先订阅 ai-done 再 call：事件在 call resolve 前后到达都不会丢。
      // 注意：不要用"闭包里给 unDone 赋值"的写法——TS 对闭包赋值 +
      // finally 读取会推断成 never 报错，这里直接 await listen 拿取消函数。
      let resolveDone: ((v: { ok: boolean; error?: string }) => void) | null = null;
      const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
        resolveDone = resolve;
      });
      unDone = await listen<{
        pluginId: string;
        event: string;
        data: { ok: boolean; error?: string };
      }>("plugin-event", (e) => {
        if (e.payload.pluginId !== "core-ai" || e.payload.event !== "ai-done") return;
        resolveDone?.(e.payload.data);
      });
      await aiChatStream(messages);
      const outcome = await done;
      if (!outcome.ok) throw new Error(outcome.error ?? "流式对话失败");
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
      unDone?.();
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

  /* 预设动作：基于当前笔记内容 */
  const currentNote = vault.activePath && vault.content ? vault.content : null;
  const noteName = vault.activePath ?? "未打开笔记";

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

  /* RAG：检索相关笔记片段作为上下文回答 */
  const askWithRag = async () => {
    const q = input.trim();
    if (!q || busyRef.current) return;
    if (!vault.path) {
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
      const hits = await searchAll(vault.path, question);
      const top = hits.slice(0, 3);
      const chunks: string[] = [];
      for (const h of top) {
        try {
          const text = await fsRead(vault.path, h.path);
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
          <button className="btn btn-sm" onClick={() => nav.go("settings")}>
            配置 AI
          </button>
        </div>
      </header>

      <div className="ai-body">
        <div className="ai-chat" aria-live="polite">
          {entries.length === 0 ? (
            <div className="ai-empty">
              <IconSparkle width={26} height={26} />
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
