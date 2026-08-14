import type { CSSProperties, ComponentType, SVGProps } from "react";
import type { PingInfo } from "../core/ipc";
import type { ThemeMode } from "../themes/theme";
import {
  IconCheckSquare,
  IconFileText,
  IconGlobe,
  IconNotebook,
  IconSliders,
  IconSparkle,
} from "./icons";

interface Module {
  name: string;
  desc: string;
  milestone: string;
  done: boolean;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const MODULES: Module[] = [
  {
    name: "笔记",
    desc: "Markdown 编辑、文件树与全文搜索，以普通文件落地，可 git 版本化。",
    milestone: "M1 已完成",
    done: true,
    icon: IconFileText,
  },
  {
    name: "数据工具",
    desc: "JSON 格式化、时间戳转换、CSV 转换等，以插件形式内置。",
    milestone: "M3 规划中",
    done: false,
    icon: IconSliders,
  },
  {
    name: "清单",
    desc: "工作清单与打卡，结构化 JSON 存储，可与笔记双向链接。",
    milestone: "M4 规划中",
    done: false,
    icon: IconCheckSquare,
  },
  {
    name: "记录",
    desc: "工作日志与流水记录，支持筛选、统计与导出。",
    milestone: "M4 规划中",
    done: false,
    icon: IconNotebook,
  },
  {
    name: "AI 整理",
    desc: "选段摘要、笔记问答（RAG），提供商可配置，以插件接入。",
    milestone: "M6 规划中",
    done: false,
    icon: IconSparkle,
  },
  {
    name: "博客发布",
    desc: "笔记带 frontmatter 一键发布，集成 Zola 静态博客生成。",
    milestone: "M7 规划中",
    done: false,
    icon: IconGlobe,
  },
];

interface WelcomeViewProps {
  ping: PingInfo | null;
  theme: ThemeMode;
  onOpenNotes: () => void;
}

export function WelcomeView({ ping, theme, onOpenNotes }: WelcomeViewProps) {
  const ok = ping?.message === "pong";

  return (
    <div>
      <section className="hero fade-in">
        <div className="hero-overline">ToolBox · Personal Workbench</div>
        <h1>个人工具箱</h1>
        <p>
          笔记、数据、清单与博客发布，围绕一个普通文件夹展开。
          数据始终是你的，随时可迁移、可备份、可发布。
        </p>
        <div className="hero-actions">
          <button className="btn-primary" onClick={onOpenNotes}>
            进入笔记
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
          <span className="env-value">
            {theme === "light" ? "亮色" : "暗色"}（右上角可切换）
          </span>
        </div>
      </section>

      <section>
        <h2 className="section-title">模块路线图</h2>
        <div className="module-grid">
          {MODULES.map((m, i) => {
            const Icon = m.icon;
            return (
              <article
                key={m.name}
                className="module-card fade-in"
                style={{ "--i": i, animationDelay: `${120 + i * 60}ms` } as CSSProperties}
              >
                <Icon className="module-icon" width={20} height={20} />
                <div className="module-name">{m.name}</div>
                <p className="module-desc">{m.desc}</p>
                <div className="module-meta">
                  <span className={`tag ${m.done ? "tag-done" : "tag-plan"}`}>
                    {m.milestone}
                  </span>
                  <span className="tag tag-muted">插件化</span>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <div className="hint fade-in">
        <kbd>Ctrl</kbd>+<kbd>K</kbd>
        <span>命令面板将于 M2 插件系统落地后开放</span>
      </div>
    </div>
  );
}
