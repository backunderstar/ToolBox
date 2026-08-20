import { useEffect, useReducer, useRef, useState } from "react";
import { isCoreConnected, type PingInfo } from "../core/ipc";
import type { NavConfig, NavItemDef } from "../core/navPrefs";
import { useVault } from "../core/vault";
import { openInExplorer, configExport, configImport } from "../core/api";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  listThemes,
  findTheme,
  swatchOf,
  deleteCustomTheme,
  exportThemesJson,
  importThemesJson,
  resolveThemeId,
  SYSTEM_THEME_ID,
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

/**
 * 设置页：工作区 / 主题（选择器 + 新建/删除/导出导入 + 编辑器）/
 * 导航栏全配置（NavSettings）/ AI 提供商（AISettings）/ 备份（BackupSettings）/
 * 关于与自动更新。
 * 主题列表来自 themes.ts（内置 + 皮肤插件投影 + localStorage 自定义）。
 */
import { check as checkUpdate } from "@tauri-apps/plugin-updater";

interface SettingsViewProps {
  themeId: string;
  onSetThemeId: (id: string) => void;
  ping: PingInfo | null;
  /** 归一化后的导航配置（分组/顺序/元数据） */
  navConfig: NavConfig;
  /** 全部导航项定义（静态 + 插件声明） */
  defs: NavItemDef[];
  /** 导航配置变更（保存用户编辑结果） */
  onNavChange: (cfg: NavConfig) => void;
}

/** 前端 localStorage 配置段（键集合；导入/导出共用）。模块级常量：避免每次渲染重建 */
const FRONTEND_KEYS = ["toolbox.theme", "toolbox.custom-themes", "toolbox.nav", "toolbox.layout"];

export function SettingsView({
  themeId,
  onSetThemeId,
  ping,
  navConfig,
  defs,
  onNavChange,
}: SettingsViewProps) {
  const vault = useVault();
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState<ThemeDef | null>(null);
  const [themeIo, setThemeIo] = useState(false);
  const [confirmDelTheme, setConfirmDelTheme] = useState<ThemeDef | null>(null);
  /* 删除/新建自定义主题后强制重渲染（listThemes 读 localStorage） */
  const [, force] = useReducer((x: number) => x + 1, 0);
  /* 自动更新状态：idle 未检查 / checking 检查中 / latest 已最新 / installing 下载安装中 /
     done 安装完成待重启 / error 失败 */
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "latest" | "installing" | "done" | "error"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [updateErr, setUpdateErr] = useState("");
  /* 配置迁移：exporting/importing 进行中；msg 操作结果提示 */
  const [configBusy, setConfigBusy] = useState<"" | "exporting" | "importing">("");
  const [configMsg, setConfigMsg] = useState("");

  /* 配置导入后的延迟刷新定时器：组件卸载时清理（防止卸载后 reload） */
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );

  /* 前端 localStorage 配置段（键集合；导入/导出共用） */

  const collectFrontend = (): Record<string, string> => {
    const o: Record<string, string> = {};
    for (const k of FRONTEND_KEYS) {
      const v = localStorage.getItem(k);
      if (v !== null) o[k] = v;
    }
    return o;
  };

  const onExportConfig = async () => {
    try {
      setConfigBusy("exporting");
      const path = await save({
        defaultPath: "toolbox-config.json",
        filters: [{ name: "ToolBox 配置", extensions: ["json"] }],
      });
      if (typeof path !== "string") return; // 用户取消
      await configExport(path, collectFrontend());
      setConfigMsg("配置已导出（不含 API Key 与笔记数据）");
    } catch (e) {
      setConfigMsg(`导出失败: ${String(e)}`);
    } finally {
      setConfigBusy("");
    }
  };

  const onImportConfig = async () => {
    try {
      setConfigBusy("importing");
      const path = await open({
        multiple: false,
        filters: [{ name: "ToolBox 配置", extensions: ["json"] }],
      });
      if (typeof path !== "string") return; // 用户取消
      const cfg = await configImport(path); // 宿主侧（插件状态/备份/AI）已写回
      // 写回前端 localStorage 段
      for (const [k, v] of Object.entries(cfg.frontend ?? {})) {
        if (typeof v === "string" && v) localStorage.setItem(k, v);
      }
      setConfigMsg("配置已导入，正在刷新界面…");
      // 主题/导航是 React 初始 state，刷新后从 localStorage 重读；
      // 插件启停也随 PluginProvider 重新拉取生效
      reloadTimer.current = setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setConfigMsg(`导入失败: ${String(e)}`);
    } finally {
      setConfigBusy("");
    }
  };

  const onCheckUpdate = async () => {
    try {
      setUpdateStatus("checking");
      const update = await checkUpdate();
      if (!update) {
        setUpdateStatus("latest");
        return;
      }
      setUpdateVersion(update.version);
      setUpdateStatus("installing");
      await update.downloadAndInstall();
      setUpdateStatus("done");
    } catch (e) {
      setUpdateStatus("error");
      setUpdateErr(String(e));
    }
  };

  const themes = listThemes();
  // 跟随系统时 findTheme 直接查不到——解析到当前系统 base 的实际主题
  // （ThemeEditor "基于当前主题新建" 的起点、描述文案等都用它）
  const current = findTheme(resolveThemeId(themeId));

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

  const ok = isCoreConnected(ping);

  const newTheme = () => {
    const base = current?.base ?? "light";
    setEditing({
      id: `custom-${Date.now().toString(36)}`,
      name: "新主题",
      base,
      description: "自定义主题",
      // 复制当前主题的令牌作起点（内置/自定义/插件主题均可）：
      // 让"基于 XX 新建"真正以 XX 为底，而不是从默认色板白手起家
      // （spread undefined 是安全的，等价于空对象）
      tokens: { ...current?.tokens },
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
                <span className="settings-hint">笔记、插件与数据都围绕一个普通文件夹展开</span>
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
                {/* 跟随系统：伪主题卡片（不在 listThemes 里，单独渲染） */}
                <div
                  key={SYSTEM_THEME_ID}
                  className={`theme-card${themeId === SYSTEM_THEME_ID ? " active" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-current={themeId === SYSTEM_THEME_ID ? "true" : undefined}
                  onClick={() => onSetThemeId(SYSTEM_THEME_ID)}
                  onKeyDown={(e) => onRowKeyDown(e, () => onSetThemeId(SYSTEM_THEME_ID))}
                  title="跟随系统亮/暗模式自动切换"
                >
                  <div className="theme-swatches">
                    {/* 亮/暗/自动三个色块示意（不依赖 swatchOf——system 不是真实主题） */}
                    <span className="theme-swatch" style={{ background: "#f6f5f2" }} />
                    <span className="theme-swatch" style={{ background: "#1b1a17" }} />
                    <span
                      className="theme-swatch"
                      style={{
                        background:
                          "linear-gradient(90deg, #f6f5f2 50%, #1b1a17 50%)",
                      }}
                    />
                  </div>
                  <div className="theme-card-name">跟随系统</div>
                  <div className="theme-card-desc">随系统亮/暗模式自动切换</div>
                </div>
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
                        <span key={i} className="theme-swatch" style={{ background: c }} />
                      ))}
                    </div>
                    <div className="theme-card-name">
                      {t.name}
                      {t.source === "plugin" && (
                        <span className="theme-card-badge" title="来自插件（皮肤插件，在插件页管理）">
                          插件
                        </span>
                      )}
                    </div>
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
                <span className="settings-hint">自定义主题保存在本机，可随时调整或删除</span>
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
        <NavSettings config={navConfig} defs={defs} onChange={onNavChange} />

        {/* ---- 配置迁移 ---- */}
        <section className="settings-card">
          <h2 className="settings-title">配置迁移</h2>
          <div className="settings-row">
            <span className="settings-label">导入 / 导出</span>
            <div className="settings-actions">
              <button
                className="btn"
                onClick={() => void onExportConfig()}
                disabled={configBusy !== ""}
              >
                {configBusy === "exporting" ? "导出中…" : "导出配置"}
              </button>
              <button
                className="btn"
                onClick={() => void onImportConfig()}
                disabled={configBusy !== ""}
              >
                {configBusy === "importing" ? "导入中…" : "导入配置"}
              </button>
              <span className="settings-hint">
                主题、导航、AI 设置与插件启停状态（不含笔记数据与 API Key）
              </span>
            </div>
          </div>
          {configMsg && <div className="settings-value">{configMsg}</div>}
        </section>

        {/* ---- 关于 ---- */}
        <section className="settings-card">
          <h2 className="settings-title">关于</h2>
          <div className="settings-row">
            <span className="settings-label">ToolBox</span>
            <span className="settings-value">{APP_TAG}</span>
          </div>
          <div className="settings-row">
            <span className="settings-label">核心版本</span>
            <span className="settings-value">{ping ? `v${ping.coreVersion}` : "—"}</span>
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
          <div className="settings-row">
            <span className="settings-label">自动更新</span>
            <span className="settings-value">
              {updateStatus === "idle" && "从 GitHub Releases 检测新版本"}
              {updateStatus === "checking" && "正在检查…"}
              {updateStatus === "latest" && "已是最新版本"}
              {updateStatus === "installing" && `发现 v${updateVersion}，正在下载安装…`}
              {updateStatus === "done" && `v${updateVersion} 已安装，请重启应用生效`}
              {updateStatus === "error" && "检查失败（未配置发布源或网络异常）"}
            </span>
            <button
              className="btn-ghost sm"
              onClick={() => void onCheckUpdate()}
              disabled={updateStatus === "checking" || updateStatus === "installing"}
              title="检查 GitHub Releases 是否有新版本"
            >
              {updateStatus === "checking" ? "检查中…" : updateStatus === "installing" ? "安装中…" : "检查更新"}
            </button>
          </div>
          {updateStatus === "error" && updateErr && (
            <div className="settings-value warn" style={{ fontSize: 11, marginTop: 4 }}>
              {updateErr.slice(0, 120)}
            </div>
          )}
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
          <button
            className="btn btn-sm"
            onClick={() => void copyExport()}
            disabled={!exported.trim()}
          >
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
      {msg && <p className={`settings-message ${msgErr ? "err" : "ok"}`}>{msg}</p>}
    </div>
  );
}
