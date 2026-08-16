// core-blog 插件自带前端（组件模式）：经宿主 PluginUiView 加载。
// 依赖（react/react-dom）由本入口构建进 IIFE bundle；宿主注入 api：
//   api.call(command, args?, targetPluginId?) —— plugin_call（默认调本插件）
//   api.on(event, cb) -> unsubscribe —— 订阅本插件的 plugin-event
//   api.context.vault —— 当前工作区路径
import React, { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./style.css";

/** 宿主注入的桥 API（PluginUiView 构造，契约与 SDK 一致） */
interface PluginUiApi {
  pluginId: string;
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  on: (event: string, cb: (data: unknown) => void) => () => void;
  context: { vault: string | null };
}

interface PostMeta {
  path: string;
  title: string;
  date: string;
  tags: string[];
  status: string;
  mtime: number | null;
}

interface BlogListResult {
  posts: PostMeta[];
  siteGeneratedAt: number | null;
  staleCount: number;
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
}

export function BlogPluginUi({ api }: { api: PluginUiApi }) {
  const [result, setResult] = useState<BlogListResult | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgErr, setMsgErr] = useState(false);
  const show = (t: string, err = false) => {
    setMsg(t);
    setMsgErr(err);
  };

  const refresh = async () => {
    try {
      const r = (await api.call("blog.list")) as BlogListResult;
      setResult(r);
    } catch (e) {
      show(String(e), true);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const generate = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await api.call("blog.generate", { siteTitle: title })) as {
        posts: number;
      };
      show(`站点已生成：${r.posts} 篇`);
      setTitle("");
      await refresh();
    } catch (e) {
      show(String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const url = (await api.call("blog.previewStart")) as string;
      show(`预览：${url}`);
      window.open(url, "_blank");
    } catch (e) {
      show(String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    try {
      await api.call("blog.openFolder");
    } catch (e) {
      show(String(e), true);
    }
  };

  /** 发布状态切换：改笔记 frontmatter 的 status 字段（经 core-notes 读写） */
  const toggleStatus = async (p: PostMeta) => {
    try {
      const raw = (await api.call("notes.read", { rel: p.path }, "core-notes")) as string;
      const next = raw.replace(
        /^(status\s*:\s*)(\S+)/m,
        (_, k: string, v: string) => `${k}${v === "published" ? "draft" : "published"}`
      );
      if (next === raw) {
        show(`「${p.title}」没有 status 字段，无法切换发布状态`, true);
        return;
      }
      await api.call("notes.write", { rel: p.path, content: next }, "core-notes");
      await refresh();
      show(`「${p.title}」已${raw.includes("published") ? "撤回草稿" : "发布"}`);
    } catch (e) {
      show(String(e), true);
    }
  };

  const stale = result?.staleCount ?? 0;

  return (
    <div className="blog-plugin-ui">
      <header className="view-header">
        <div>
          <h1>博客发布</h1>
          <p className="view-sub">frontmatter → 站点生成 / 预览 / 发布</p>
        </div>
      </header>

      {result?.siteGeneratedAt != null && stale > 0 && (
        <div className="settings-message warn">
          有 {stale} 篇已发布笔记在站点生成后更新过，请重新生成站点
        </div>
      )}

      <div className="blog-ui-toolbar">
        <input
          className="settings-input"
          placeholder="站点标题（默认 ToolBox 博客）"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void generate()}
        />
        <button className="btn" onClick={() => void generate()} disabled={busy}>
          {busy ? "处理中…" : "生成站点"}
        </button>
        <button className="btn" onClick={() => void preview()} disabled={busy || result?.siteGeneratedAt == null}>
          预览
        </button>
        <button className="btn" onClick={() => void openFolder()} disabled={result?.siteGeneratedAt == null}>
          打开站点目录
        </button>
      </div>

      {msg && <div className={`settings-message ${msgErr ? "err" : "ok"}`}>{msg}</div>}

      <div className="blog-ui-list">
        {!result ? (
          <div className="search-hint">加载中…</div>
        ) : result.posts.length === 0 ? (
          <div className="search-hint">还没有笔记（博客文章来自 notes/ 目录）</div>
        ) : (
          result.posts.map((p) => (
            <div className="blog-ui-row" key={p.path}>
              <div className="blog-ui-title">{p.title}</div>
              <div className="blog-ui-meta">
                {p.date} · {p.tags.length ? p.tags.join("、") : "无标签"}
                {p.status === "published" && <span className="badge badge-status-ready">已发布</span>}
                {p.status !== "published" && <span className="badge badge-status-stopped">草稿</span>}
              </div>
              <button className="btn btn-sm" onClick={() => void toggleStatus(p)}>
                {p.status === "published" ? "撤回草稿" : "发布"}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ---- 注册到全局（宿主 PluginUiView 注入后读取） ---- */
declare global {
  interface Window {
    __TB_PLUGIN_UI__?: Record<
      string,
      { mount: (el: HTMLElement, api: PluginUiApi) => void; unmount?: () => void }
    >;
  }
}

let root: Root | null = null;
window.__TB_PLUGIN_UI__ = window.__TB_PLUGIN_UI__ || {};
window.__TB_PLUGIN_UI__["core-blog"] = {
  mount(el, api) {
    root = createRoot(el);
    root.render(<BlogPluginUi api={api} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
