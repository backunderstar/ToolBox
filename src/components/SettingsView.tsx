import { useReducer, useState } from "react";
import type { PingInfo } from "../core/ipc";
import { useVault } from "../core/vault";
import { openInExplorer } from "../core/api";
import {
  listThemes,
  findTheme,
  swatchOf,
  deleteCustomTheme,
  type ThemeDef,
} from "../themes/themes";
import { ThemeEditor } from "./ThemeEditor";
import { AISettings } from "./AISettings";
import { IconFolder, IconPlus, IconTrash } from "./icons";

interface SettingsViewProps {
  themeId: string;
  onSetThemeId: (id: string) => void;
  ping: PingInfo | null;
}

export function SettingsView({ themeId, onSetThemeId, ping }: SettingsViewProps) {
  const vault = useVault();
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState<ThemeDef | null>(null);
  /* 删除/新建自定义主题后强制重渲染（listThemes 读 localStorage） */
  const [, force] = useReducer((x: number) => x + 1, 0);

  const themes = listThemes();
  const current = findTheme(themeId);

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

  const newTheme = () => {
    const base = current?.base ?? "light";
    setEditing({
      id: `custom-${Date.now().toString(36)}`,
      name: "新主题",
      base,
      description: "自定义主题",
      tokens: {},
      custom: true,
    });
  };

  const removeCustom = (id: string) => {
    if (!window.confirm("删除这个自定义主题？")) return;
    deleteCustomTheme(id);
    if (themeId === id) onSetThemeId("default-light");
    setEditing(null);
    force();
  };

  return (
    <div className="settings-view scroll-area">
      <header className="view-header">
        <div>
          <h1>设置</h1>
          <p className="view-sub">工作区、主题与关于信息</p>
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
                  <button className="btn" onClick={openFolder} disabled={opening}>
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

        {/* ---- 外观 / 主题 ---- */}
        <section className="settings-card">
          <h2 className="settings-title">主题</h2>
          {!editing ? (
            <>
              <div className="theme-grid">
                {themes.map((t) => (
                  <div
                    key={t.id}
                    className={`theme-card${themeId === t.id ? " active" : ""}`}
                    onClick={() => onSetThemeId(t.id)}
                    title={t.description}
                  >
                    <div className="theme-swatches">
                      {swatchOf(t).map((c, i) => (
                        <span
                          key={i}
                          className="theme-swatch"
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                    <div className="theme-card-name">{t.name}</div>
                    <div className="theme-card-desc">{t.description}</div>
                    {t.custom && (
                      <button
                        className="theme-delete"
                        title="删除主题"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeCustom(t.id);
                        }}
                      >
                        <IconTrash width={12} height={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="theme-actions">
                <button className="btn btn-sm" onClick={newTheme}>
                  <IconPlus width={12} height={12} />
                  基于当前主题新建
                </button>
                <span className="settings-hint">
                  自定义主题保存在本机，可随时调整或删除
                </span>
              </div>
            </>
          ) : (
            <ThemeEditor
              initial={editing}
              onCancel={() => {
                setEditing(null);
                onSetThemeId(themeId); // 恢复原主题
              }}
              onSaved={(id) => {
                setEditing(null);
                onSetThemeId(id);
              }}
            />
          )}
        </section>

        {/* ---- AI 提供商 ---- */}
        <AISettings />

        {/* ---- 关于 ---- */}
        <section className="settings-card">
          <h2 className="settings-title">关于</h2>
          <div className="settings-row">
            <span className="settings-label">ToolBox</span>
            <span className="settings-value">v0.1.0 · M1–M7</span>
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
