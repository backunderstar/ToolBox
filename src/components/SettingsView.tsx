import { useState } from "react";
import type { PingInfo } from "../core/ipc";
import type { ThemeMode } from "../themes/theme";
import { useVault } from "../core/vault";
import { openInExplorer } from "../core/api";
import { IconFolder } from "./icons";

interface SettingsViewProps {
  theme: ThemeMode;
  onSetTheme: (t: ThemeMode) => void;
  ping: PingInfo | null;
}

export function SettingsView({ theme, onSetTheme, ping }: SettingsViewProps) {
  const vault = useVault();
  const [opening, setOpening] = useState(false);

  const openFolder = async () => {
    if (!vault.path) return;
    setOpening(true);
    try {
      await openInExplorer(vault.path);
    } catch (e) {
      console.error("[settings] 打开工作区失败", e);
    } finally {
      setOpening(false);
    }
  };

  const ok = ping?.message === "pong";

  return (
    <div className="settings-view scroll-area">
      <header className="view-header">
        <div>
          <h1>设置</h1>
          <p className="view-sub">工作区、外观与关于信息</p>
        </div>
      </header>

      <div className="settings-sections">
        {/* ---- 工作区 ---- */}
        <section className="settings-card">
          <h2 className="settings-title">工作区</h2>
          {vault.path ? (
            <>
              <div className="settings-row">
                <span className="settings-label">当前工作区</span>
                <code className="settings-path" title={vault.path}>
                  {vault.path}
                </code>
              </div>
              <div className="settings-row">
                <span className="settings-label">操作</span>
                <div className="settings-actions">
                  <button className="btn" onClick={vault.pickVault}>
                    更换工作区
                  </button>
                  <button
                    className="btn"
                    onClick={openFolder}
                    disabled={opening}
                  >
                    <IconFolder width={13} height={13} />
                    {opening ? "打开中…" : "在资源管理器中打开"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="settings-row">
              <span className="settings-label">工作区</span>
              <div className="settings-actions">
                <button className="btn" onClick={vault.pickVault}>
                  选择工作区文件夹
                </button>
                <span className="settings-hint">
                  笔记、插件与数据都围绕一个普通文件夹展开
                </span>
              </div>
            </div>
          )}
        </section>

        {/* ---- 外观 ---- */}
        <section className="settings-card">
          <h2 className="settings-title">外观</h2>
          <div className="settings-row">
            <span className="settings-label">主题</span>
            <div className="segmented">
              <button
                className={`segmented-item${theme === "light" ? " active" : ""}`}
                onClick={() => onSetTheme("light")}
              >
                亮色
              </button>
              <button
                className={`segmented-item${theme === "dark" ? " active" : ""}`}
                onClick={() => onSetTheme("dark")}
              >
                暗色
              </button>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">编辑器</span>
            <span className="settings-value">Markdown 即时渲染（Vditor）</span>
          </div>
        </section>

        {/* ---- 关于 ---- */}
        <section className="settings-card">
          <h2 className="settings-title">关于</h2>
          <div className="settings-row">
            <span className="settings-label">ToolBox</span>
            <span className="settings-value">v0.1.0 · M1 笔记 + M2 插件系统</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">核心版本</span>
            <span className="settings-value">
              {ping ? `v${ping.coreVersion}` : "—"}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-label">平台</span>
            <span className="settings-value">{ping?.os ?? "—"}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">IPC 链路</span>
            <span className={`settings-value ${ok ? "ok" : "warn"}`}>
              {ping ? ping.message : "连接中…"}
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
