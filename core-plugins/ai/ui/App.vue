<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { PluginBridgeApi } from "./bridge";

/**
 * core-ai 插件自带前端（组件模式）——Vue 3：AI 整理视图（对话 + 预设动作 + 笔记问答轻量 RAG）。
 * CSS 复用宿主全局样式（.ai-view/.view-header/.ai-body 等 class 在宿主 shell.css）。
 * 命令面（全部经 api.call，本插件 core-ai）：
 *   ai.chatStream { messages } —— 流式对话：立即返回（Rust 侧独立线程执行），
 *                              增量经 ai-chunk 事件到达，结束/失败经 ai-done 事件
 *   ai.chat { messages } —— 非流式，返回完整回复字符串（本视图未使用）
 * 跨插件：core-notes notes.read（读取命中片段）；RAG 检索经宿主内嵌全文搜索（api.host.search）。
 */
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

const props = defineProps<{ api: PluginBridgeApi }>();

// 当前笔记上下文：宿主在挂载时注入快照（activePath / activeContent）作为初始值。
// 快照只在挂载时有效——宿主 vault 的状态在插件 UI 之外变化（用户在笔记视图
// 切换文件），插件必须**自行订阅 tb:vault-active 事件**保持上下文最新。
const currentNote = ref<string | null>(() => {
  const c = props.api.context.activeContent;
  return typeof c === "string" && c ? c : null;
});
const noteName = ref<string>(() => {
  const p = props.api.context.activePath;
  return typeof p === "string" && p ? p : "未打开笔记";
});

/* 订阅宿主 vault 的当前文件广播：插件 UI 存活期间持续刷新上下文 */
onMounted(() => {
  const onActive = (e: Event) => {
    const d = (e as CustomEvent<{ rel?: string; content?: string }>).detail;
    if (typeof d?.rel === "string" && d.rel) {
      noteName.value = d.rel;
      if (typeof d.content === "string") currentNote.value = d.content;
    }
  };
  window.addEventListener("tb:vault-active", onActive);
  onBeforeUnmount(() => window.removeEventListener("tb:vault-active", onActive));
});

const entries = ref<ChatEntry[]>([]);
const input = ref("");
const busy = ref(false);
const bottomRef = ref<HTMLDivElement | null>(null);
// 防并发守卫：`busy` 是渲染闭包快照，连按回车时第二次调用仍读到 false
// → 会并发发出重复请求、回复乱序。用同步变量做检查 + 立即置位。
let busyGuard = false;
// 流式累积：正在生成的 assistant 消息索引 + 已收到的文本
let stream: { idx: number; text: string } | null = null;
// 累计消息数：流式事件更新 entries，索引必须稳定
let count = 0;

function push(e: ChatEntry): void {
  entries.value = [...entries.value, e];
  count += 1;
}

function scrollToBottom(): void {
  setTimeout(() => bottomRef.value?.scrollIntoView({ behavior: "smooth" }), 50);
}

/**
 * 流式对话公共流程：建占位 assistant 消息 → 订阅 ai-chunk 逐段累积 →
 * 等待 ai-done 结束事件后收尾。调用方负责先 push user 消息并构造 messages。
 *
 * 注意：`ai.chatStream` 现在**立即返回**（Rust 侧把流式请求派发到独立线程，
 * 避免宿主 tokio 线程上 block_on 嵌套 panic），所以"流结束"的判定从
 * "call resolve"改为订阅 `ai-done` 事件（载荷 `{ok, error?}`）。
 */
async function runChatStream(messages: ChatMessage[]): Promise<void> {
  const idx = count;
  push({ role: "assistant", content: "" });
  stream = { idx, text: "" };
  let un: (() => void) | null = null;
  let unDone: (() => void) | null = null;
  try {
    // api.on 已按本插件（core-ai）+ 事件名过滤，回调直接收到 { text }
    un = props.api.on("ai-chunk", (data) => {
      const s = stream;
      if (!s) return;
      s.text += (data as AiChunk).text ?? "";
      const next = [...entries.value];
      next[s.idx] = { role: "assistant", content: s.text };
      entries.value = next;
      scrollToBottom();
    });
    // 先订阅 ai-done 再 call：事件在 call resolve 前后到达都不会丢
    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      unDone = props.api.on("ai-done", (data) => {
        resolve(data as { ok: boolean; error?: string });
      });
    });
    await props.api.call("ai.chatStream", { messages });
    const outcome = await done;
    if (!outcome.ok) throw new Error(outcome.error ?? "流式对话失败");
  } catch (e) {
    const msg = String(e);
    const friendly = msg.includes("未配置 API Key")
      ? `${msg}\n\n请先到「设置 → AI 提供商」填写配置。`
      : msg;
    const next = [...entries.value];
    const s = stream;
    next[s?.idx ?? next.length - 1] = {
      role: "assistant",
      content: friendly,
      error: true,
    };
    entries.value = next;
  } finally {
    un?.();
    unDone?.();
    stream = null;
    busyGuard = false;
    busy.value = false;
    scrollToBottom();
  }
}

async function runChat(userText: string): Promise<void> {
  if (!userText.trim() || busyGuard) return;
  busyGuard = true;
  busy.value = true;
  input.value = "";
  push({ role: "user", content: userText });
  scrollToBottom();
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是 ToolBox 的个人工作助理。回答简洁、准确，使用中文。涉及用户笔记时基于提供的内容作答。",
    },
    // 只带最近 10 条对话历史，避免长会话触发上下文超限
    ...entries.value
      .filter((e) => !e.error)
      .slice(-10)
      .map((e): ChatMessage => ({ role: e.role, content: e.content })),
    { role: "user", content: userText },
  ];
  await runChatStream(messages);
}

/* 预设动作：基于当前笔记内容 */
function preset(action: string): void {
  if (!currentNote.value) {
    push({
      role: "assistant",
      content: "请先在「笔记」中打开一篇笔记，再使用预设动作。",
      error: true,
    });
    return;
  }
  const snippet = currentNote.value.slice(0, 4000);
  const prompts: Record<string, string> = {
    summary: `请总结这篇笔记（《${noteName.value}》），输出 3-5 条要点。\n\n笔记内容：\n${snippet}`,
    outline: `请为这篇笔记（《${noteName.value}》）提取大纲结构。\n\n笔记内容：\n${snippet}`,
    polish: `请润色这篇笔记（《${noteName.value}》），保持原意，改进表达。只输出润色后的全文。\n\n笔记内容：\n${snippet}`,
  };
  void runChat(prompts[action] ?? action);
}

/* RAG：跨插件检索相关笔记片段作为上下文回答 */
async function askWithRag(): Promise<void> {
  const q = input.value.trim();
  if (!q || busyGuard) return;
  if (!props.api.context.vault) {
    push({ role: "assistant", content: "请先选择工作区。", error: true });
    return;
  }
  busyGuard = true;
  busy.value = true;
  const question = q;
  input.value = "";
  push({ role: "user", content: `（基于笔记检索）${question}` });
  scrollToBottom();
  try {
    // 宿主内嵌全文搜索（经统一桥 host.search，含搜索提供者聚合），取前 3 个命中
    const hits = props.api.host ? await props.api.host.search(question) : [];
    const top = hits.slice(0, 3);
    const chunks: string[] = [];
    for (const h of top) {
      try {
        // 跨插件：core-notes 读取命中文件内容（最多 1500 字符）
        const text = (await props.api.call("notes.read", { rel: h.path }, "core-notes")) as string;
        chunks.push(`【${h.path}】\n${text.slice(0, 1500)}`);
      } catch {
        /* 跳过读取失败 */
      }
    }
    const context = chunks.length > 0 ? chunks.join("\n\n---\n\n") : "（未检索到相关笔记）";
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
    busyGuard = false;
    busy.value = false;
    scrollToBottom();
  }
}
</script>

<template>
  <div class="ai-view">
    <header class="view-header">
      <div>
        <h1>AI 整理</h1>
        <p class="view-sub">对话、总结笔记、问答检索（需在设置页配置 AI 提供商）</p>
      </div>
      <div class="view-actions">
        <!-- 宿主 nav 桥不可用时（如浮窗）隐藏跳转按钮 -->
        <button v-if="api.nav" class="btn btn-sm" @click="api.nav?.go('settings')">
          配置 AI
        </button>
      </div>
    </header>

    <div class="ai-body">
      <div class="ai-chat" aria-live="polite">
        <div v-if="entries.length === 0" class="ai-empty">
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z" />
            <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
          </svg>
          <p>开始一段对话，或用下面的动作整理笔记</p>
          <p class="ai-hint">
            {{
              currentNote
                ? `当前上下文：${noteName}`
                : "提示：打开一篇笔记后可用「总结 / 提炼 / 润色」"
            }}
          </p>
        </div>
        <div
          v-for="(e, i) in entries"
          :key="i"
          class="ai-msg"
          :class="[`ai-msg-${e.role}`, { err: e.error }]"
        >
          <div class="ai-msg-role">{{ e.role === "user" ? "你" : "AI" }}</div>
          <div class="ai-msg-content">
            {{ e.content || (e.role === "assistant" ? "思考中…" : "") }}
          </div>
        </div>
        <div ref="bottomRef" />
      </div>

      <div class="ai-actions">
        <div class="ai-presets">
          <button
            class="btn btn-sm"
            @click="preset('summary')"
            :disabled="!currentNote || busy"
          >
            总结当前笔记
          </button>
          <button
            class="btn btn-sm"
            @click="preset('outline')"
            :disabled="!currentNote || busy"
          >
            提炼大纲
          </button>
          <button
            class="btn btn-sm"
            @click="preset('polish')"
            :disabled="!currentNote || busy"
          >
            润色
          </button>
        </div>
        <div class="ai-input-row">
          <input
            class="ai-chat-input"
            v-model="input"
            @keydown.enter.exact.prevent="runChat(input)"
            placeholder="提问，或输入问题后点「笔记问答」检索笔记回答…"
          />
          <button class="btn btn-sm" @click="askWithRag" :disabled="busy || !input.trim()">
            笔记问答
          </button>
          <button class="btn btn-primary-ai" @click="runChat(input)" :disabled="busy || !input.trim()">
            {{ busy ? "思考中…" : "发送" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
