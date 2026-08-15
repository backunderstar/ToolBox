import { useReducer, useState } from "react";
import type { PingInfo } from "../core/ipc";
import type { NavPrefs } from "../core/navPrefs";
import { useVault } from "../core/vault";
import { openInExplorer } from "../core/api";
import {
  listThemes,
  findTheme,
  swatchOf,
  deleteCustomTheme,
  exportThemesJson,
  importThemesJson,
  type ThemeDef,
} from "../themes/themes";
import { ThemeEditor } from "./ThemeEditor";
import { AISettings } from "./AISettings";
import { BackupSettings } from "./BackupSettings";
import { NavSettings } from "./NavSettings";
import { IconFolder, IconPlus, IconTrash } from "./icons";
import { APP_TAG } from "../core/version";
import { onRowKeyDown } from "../core/keyboard";
import { ConfirmDialog } from "./ConfirmDialog";

interface SettingsViewProps {
  themeId: string;
  onSetThemeId: (id: string) => void;
  ping: PingInfo | null;
  navPrefs: NavPrefs;
  onNavPrefsChange: (prefs: NavPrefs) => void;
}

export function SettingsView({
  themeId,
  onSetThemeId,
  ping,
  navPrefs,
  onNavPrefsChange,
}: SettingsViewProps) {
  const vault = useVault();
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState<ThemeDef | null>(null);
  const [themeIo, setThemeIo] = useState(false);
  const [confirmDelTheme, setConfirmDelTheme] = useState<ThemeDef | null>(null);
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
    deleteCustomTheme(id);
    if (themeId === id) onSetThemeId("default-light");
    setEditing(null);
    setConfirmDelTheme(null);
    force();
  };

  return (
    <div className="settings-view">
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
                    role="button"
                    tabIndex={0}
                    aria-current={themeId === t.id ? "true" : undefined}
                    onClick={() => onSetThemeId(t.id)}
                    onKeyDown={(e) => onRowKeyDown(e, () => onSetThemeId(t.id))}
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
                        aria-label={`删除主题 ${t.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelTheme(t);
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
                <button className="btn btn-sm" onClick={() => setThemeIo((v) => !v)}>
                  {themeIo ? "收起导出/导入" : "导出 / 导入主题"}
                </button>
                <span className="settings-hint">
                  自定义主题保存在本机，可随时调整或删除
                </span>
              </div>
              {themeIo && (
                <ThemeIoPanel
                  onDone={() => {
                    setThemeIo(false);
                    force();
                  }}
                />
              )}
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

        {/* ---- 备份 ---- */}
        <BackupSettings />

        {/* ---- 导航栏 ---- */}
        <NavSettings prefs={navPrefs} onChange={onNavPrefsChange} />

        {/* ---- 关于 ---- */}
        <section className="settings-card">
          <h2 className="settings-title">关于</h2>
          <div className="settings-row">
            <span className="settings-label">ToolBox</span>
            <span className="settings-value">{APP_TAG}</span>
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
      <ConfirmDialog
        open={confirmDelTheme !== null}
        title="删除主题"
        message={confirmDelTheme ? `确定删除自定义主题「${confirmDelTheme.name}」？` : ""}
        confirmText="删除"
        danger
        onCancel={() => setConfirmDelTheme(null)}
        onConfirm={() => {
          if (confirmDelTheme) removeCustom(confirmDelTheme.id);
        }}
      />
    </div>
  );
}

/** 主题导出/导入面板：导出 = 复制 JSON；导入 = 粘贴 JSON 后应用。 */
function ThemeIoPanel({ onDone }: { onDone: () => void }) {
  const [exported] = useState(() => exportThemesJson());
  const [importText, setImportText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [msgErr, setMsgErr] = useState(false);

  const copyExport = async () => {
    try {
      await navigator.clipboard.writeText(exported);
      setMsg("已复制到剪贴板");
      setMsgErr(false);
    } catch {
      setMsg("复制失败：请手动选择文本复制");
      setMsgErr(true);
    }
  };

  const doImport = () => {
    try {
      const n = importThemesJson(importText);
      setMsg(`导入成功：${n} 个主题`);
      setMsgErr(false);
      onDone();
    } catch (e) {
      setMsg(String(e));
      setMsgErr(true);
    }
  };

  return (
    <div className="theme-io">
      <div className="settings-row">
        <span className="settings-label">导出</span>
        <div className="settings-actions" style={{ flex: 1, minWidth: 0 }}>
          <textarea
            className="theme-io-textarea"
            readOnly
            value={exported}
            rows={4}
            placeholder="（暂无自定义主题）"
          />
          <button className="btn btn-sm" onClick={() => void copyExport()} disabled={!exported.trim()}>
            复制
          </button>
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-label">导入</span>
        <div className="settings-actions" style={{ flex: 1, minWidth: 0 }}>
          <textarea
            className="theme-io-textarea"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={4}
            placeholder="粘贴主题 JSON（从其他机器导出的文本）"
          />
          <button className="btn btn-sm" onClick={doImport} disabled={!importText.trim()}>
            应用
          </button>
        </div>
      </div>
      {msg && (
        <p className={`settings-message ${msgErr ? "err" : "ok"}`}>{msg}</p>
      )}
    </div>
  );
}
