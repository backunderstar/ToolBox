import type { CSSProperties } from "react";
import { isCoreConnected, type PingInfo } from "../core/ipc";
import { RUNTIME_LABEL, type PluginInfo } from "../core/api";

interface WelcomeViewProps {
  ping: PingInfo | null;
  themeName: string;
  plugins: PluginInfo[];
  onOpenNotes: () => void;
  onOpenPlugins: () => void;
}

export function WelcomeView({
  ping,
  themeName,
  plugins,
  onOpenNotes,
  onOpenPlugins,
}: WelcomeViewProps) {
  const ok = isCoreConnected(ping);

  return (
    <div className="welcome">
      <section className="hero fade-in">
        <div className="hero-overline">ToolBox · Personal Workbench</div>
        <h1>个人工具箱</h1>
        <p>
          你的笔记、文件与工具，围绕一个普通文件夹展开。
          数据始终是你的——随时可迁移、可备份、可发布。
        </p>
        <div className="hero-actions">
          <button className="btn-primary" onClick={onOpenNotes}>
            开始使用
          </button>
        </div>
      </section>

      <section className="env-card fade-in" style={{ animationDelay: "80ms" }}>
        <div className="env-item">
          <span className="env-key">IPC 状态</span>
          <span className={`env-value${ok ? " ok" : " warn"}`}>
            {ping ? ping.message : "连接中…"}
          </span>
        </div>
        <div className="env-item">
          <span className="env-key">核心版本</span>
          <span className="env-value">v{ping?.coreVersion ?? "…"}</span>
        </div>
        <div className="env-item">
          <span className="env-key">平台</span>
          <span className="env-value">{ping?.os ?? "…"}</span>
        </div>
        <div className="env-item">
          <span className="env-key">主题</span>
          <span className="env-value">{themeName}</span>
        </div>
      </section>

      <section>
        <h2 className="section-title">已安装插件</h2>
        {plugins.length === 0 ? (
          <p className="module-empty">暂无插件</p>
        ) : (
          <div className="module-grid">
            {plugins.map((p, i) => (
              <article
                key={p.id}
                className="module-card module-card-clickable fade-in"
                // 入场动画延迟封顶（Math.min(i, 8)）：插件很多时最后一张卡
                // 不会等 1.6s+ 才出现，动画节奏保持紧凑
                style={{ "--i": i, animationDelay: `${120 + Math.min(i, 8) * 50}ms` } as CSSProperties}
                onClick={onOpenPlugins}
                title="点击进入插件页"
              >
                <div className="module-name">
                  {p.name}
                  {p.builtin && <span className="tag tag-core">核心</span>}
                  {p.system && <span className="tag tag-muted">系统</span>}
                  {p.provider && <span className="tag tag-muted">搜索提供者</span>}
                </div>
                <p className="module-desc">{p.description}</p>
                <div className="module-meta">
                  <span className="tag tag-muted">{RUNTIME_LABEL[p.runtime] ?? p.runtime}</span>
                  <span className="tag tag-muted">v{p.version}</span>
                  <span className={`tag ${p.enabled ? "tag-done" : "tag-plan"}`}>
                    {p.enabled ? "已启用" : "已禁用"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="hint fade-in">
        <kbd>Ctrl</kbd>+<kbd>K</kbd>
        <span>任意视图下聚焦顶栏全局搜索，检索文件名、内容与清单待办</span>
      </div>
    </div>
  );
}
