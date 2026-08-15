import { useEffect, useState } from "react";
import { useVault } from "../core/vault";
import { useNav } from "../core/navigation";
import {
  blogList,
  blogGenerate,
  blogPreviewStart,
  blogPreviewStop,
  blogOpenFolder,
  fsRead,
  fsWrite,
  openUrl,
  type PostMeta,
} from "../core/api";
import { setStatus } from "../core/blogfm";
import { IconFolder, IconGlobe, IconSparkle } from "./icons";

/**
 * 博客发布视图（M7）：笔记 frontmatter 管理 + 一键生成站点 + 内置预览。
 */
export function BlogView() {
  const vault = useVault();
  const nav = useNav();
  const [posts, setPosts] = useState<PostMeta[]>([]);
  const [selected, setSelected] = useState<PostMeta | null>(null);
  const [siteTitle, setSiteTitle] = useState("ToolBox 博客");
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const refresh = async () => {
    if (!vault.path) return;
    try {
      const r = await blogList(vault.path);
      setPosts(r.posts);
      setSelected((cur) => {
        if (!cur) return cur;
        return r.posts.find((p) => p.path === cur.path) ?? cur;
      });
    } catch (e) {
      console.error("[blog] 列表失败", e);
    }
  };

  useEffect(() => {
    void refresh();
  }, [vault.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleStatus = async (post: PostMeta) => {
    if (!vault.path || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const raw = await fsRead(vault.path, post.path);
      const next = post.status === "published" ? "draft" : "published";
      await fsWrite(vault.path, post.path, setStatus(raw, next));
      await refresh();
      setMessage({ ok: true, text: `「${post.title}」已${next === "published" ? "发布" : "撤回"}` });
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!vault.path || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await blogGenerate(vault.path, siteTitle);
      setMessage({
        ok: true,
        text: `站点已生成：${r.posts} 篇 → ${r.siteDir}`,
      });
      setPreviewUrl(null);
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    if (!vault.path || previewBusy) return;
    setPreviewBusy(true);
    try {
      const url = await blogPreviewStart(vault.path);
      setPreviewUrl(url);
      await openUrl(url);
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setPreviewBusy(false);
    }
  };

  const stopPreview = async () => {
    await blogPreviewStop();
    setPreviewUrl(null);
  };

  const published = posts.filter((p) => p.status === "published").length;

  return (
    <div className="blog-view">
      {/* ---- 左：站点管理 + 文章列表 ---- */}
      <aside className="blog-pane">
        <div className="blog-pane-head">
          <span className="blog-pane-title">博客</span>
          <span className="blog-count">
            {published}/{posts.length} 已发布
          </span>
        </div>

        <div className="blog-site-card">
          <div className="blog-site-row">
            <input
              className="blog-site-input"
              value={siteTitle}
              onChange={(e) => setSiteTitle(e.target.value)}
              placeholder="站点标题"
              spellCheck={false}
            />
          </div>
          <div className="blog-site-actions">
            <button className="btn btn-sm" onClick={() => void generate()} disabled={busy || !vault.path}>
              {busy ? "处理中…" : "生成站点"}
            </button>
            <button className="btn btn-sm" onClick={() => void preview()} disabled={!vault.path || previewBusy}>
              {previewBusy ? "启动中…" : "预览"}
            </button>
            {previewUrl && (
              <button className="btn btn-sm" onClick={() => void stopPreview()}>
                停止预览
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void blogOpenFolder(vault.path ?? "")} disabled={!vault.path}>
              <IconFolder width={12} height={12} />
              站点目录
            </button>
          </div>
          {message && (
            <p className={`settings-message ${message.ok ? "ok" : "err"}`}>{message.text}</p>
          )}
        </div>

        <div className="blog-list-label">文章（{posts.length}）</div>
        <div className="blog-list">
          {posts.length === 0 && (
            <div className="tree-empty">
              <p>还没有带 frontmatter 的笔记</p>
              <p className="tree-empty-hint">在笔记顶部加 `status: published` 即可发布</p>
            </div>
          )}
          {posts.map((p) => (
            <div
              key={p.path}
              className={`blog-row${selected?.path === p.path ? " active" : ""}`}
              onClick={() => setSelected(p)}
            >
              <div className="blog-row-title">{p.title}</div>
              <div className="blog-row-meta">
                <span>{p.date || "无日期"}</span>
                <span className={`blog-status ${p.status === "published" ? "pub" : "draft"}`}>
                  {p.status === "published" ? "已发布" : "草稿"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ---- 右：文章详情 ---- */}
      <main className="blog-main">
        {!selected ? (
          <div className="empty-state">
            <div className="empty-icon">
              <IconGlobe width={28} height={28} />
            </div>
            <h2>博客发布</h2>
            <p>
              在笔记顶部写入 frontmatter（title / date / tags / status），
              status 为 published 的文章会进入站点。
            </p>
            <div className="hint-path">---{"\n"}title: 我的文章{"\n"}status: published{"\n"}---</div>
          </div>
        ) : (
          <div className="blog-detail">
            <div className="blog-detail-head">
              <h2>{selected.title}</h2>
              <div className="plugin-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => void toggleStatus(selected)}
                  disabled={busy}
                >
                  {selected.status === "published" ? "撤回（转草稿）" : "发布"}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => nav.openNote(selected.path)}
                >
                  打开笔记
                </button>
              </div>
            </div>
            <div className="blog-detail-meta">
              <span className="blog-detail-item">路径：{selected.path}</span>
              <span className="blog-detail-item">日期：{selected.date || "未设置"}</span>
              <span className="blog-detail-item">
                标签：{selected.tags.length ? selected.tags.join("、") : "无"}
              </span>
            </div>
            <div className="blog-tip">
              <IconSparkle width={13} height={13} />
              <span>
                编辑 frontmatter 请直接修改笔记顶部：
                title / date（YYYY-MM-DD）/ tags（逗号分隔）/ status（published | draft）
              </span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
