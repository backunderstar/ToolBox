import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { usePlugins } from "../core/plugins";
import { useVault } from "../core/vault";
import { useNav } from "../core/navigation";
import type { PluginInfo } from "../core/api";
import { pluginsRemovedCore, pluginsReinstallCore, pluginsInstallNative } from "../core/api";
import { CommandTry } from "./CommandTry";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconGear, IconRefresh, IconTrash } from "./icons";
import type { ViewId } from "./Sidebar";

const RUNTIME_LABEL: Record<string, string> = {
  webview: "JS",
  process: "Python",
  native: "原生",
};

const STATUS_TEXT: Record<string, string> = {
  ready: "就绪",
  stopped: "已停止",
  error: "错误",
};

/** 事件桥载荷（与 Rust PluginEvent camelCase 对应） */
interface PluginEventPayload {
  pluginId: string;
  event: string;
  data: unknown;
}

interface PluginEventLog extends PluginEventPayload {
  time: number;
}

export function PluginsView() {
  const vault = useVault();
  const nav = useNav();
  const {
    plugins,
    loading,
    runtimeErrors,
    refresh,
    setEnabled,
    reload,
    uninstall,
    invoke,
    commandsOf,
  } = usePlugins();

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  /** 待安装的本地插件来源（.zip 包或目录），确认后安装 */
  const [pendingInstall, setPendingInstall] = useState<{
    path: string;
    kind: "zip" | "dir";
  } | null>(null);
  const [events, setEvents] = useState<PluginEventLog[]>([]);
  /** 已卸载的核心插件 id（显示"重新安装"入口；核心插件真实卸载后不随启动恢复） */
  const [removedCore, setRemovedCore] = useState<string[]>([]);
  /** 操作错误提示（卸载/切换/重载失败时显示，可关闭）——此前仅 console.error 用户无感知 */
  const [actionError, setActionError] = useState<string | null>(null);

  /** 选择安装来源：.zip 包或插件目录（系统对话框） */
  const pickInstall = async (kind: "zip" | "dir") => {
    try {
      const sel =
        kind === "zip"
          ? await open({
              multiple: false,
              filters: [{ name: "插件压缩包", extensions: ["zip"] }],
            })
          : await open({ directory: true, multiple: false });
      if (typeof sel === "string" && sel) setPendingInstall({ path: sel, kind });
    } catch {
      /* 用户取消 */
    }
  };

  const doInstall = async () => {
    const v = vault.path;
    if (!v || !pendingInstall) return;
    const { path: src, kind } = pendingInstall;
    setPendingInstall(null);
    setBusy((b) => ({ ...b, ["@install"]: true }));
    try {
      await pluginsInstallNative(v, src, kind);
      await refresh();
    } catch (e) {
      setActionError(`安装失败: ${e}`);
    } finally {
      setBusy((b) => ({ ...b, ["@install"]: false }));
    }
  };

  const loadRemoved = () => {
    pluginsRemovedCore()
      .then(setRemovedCore)
      .catch(() => setRemovedCore([]));
  };
  useEffect(loadRemoved, []);

  const doReinstall = async (id: string) => {
    const v = vault.path;
    if (!v) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await pluginsReinstallCore(v, id);
      await refresh();
      loadRemoved();
    } catch (e) {
      setActionError(`重新安装失败: ${e}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  /* 事件桥：进程插件推送的事件（plugin-event）实时追加到日志 */
  useEffect(() => {
    let un: (() => void) | null = null;
    listen<PluginEventPayload>("plugin-event", (e) => {
      setEvents((prev) => [...prev, { ...e.payload, time: Date.now() }].slice(-50));
    })
      .then((fn) => (un = fn))
      .catch(() => {
        /* 浏览器预览环境无事件桥 */
      });
    return () => un?.();
  }, []);

  const doUninstall = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await uninstall(id);
      loadRemoved();
    } catch (e) {
      setActionError(`卸载失败: ${e}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await setEnabled(id, enabled);
    } catch (e) {
      setActionError(`操作失败: ${e}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const doReload = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await reload(id);
    } catch (e) {
      setActionError(`重载失败: ${e}`);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  /* 分组：核心插件（native，随应用分发）在前，外部插件在后 */
  const corePlugins = plugins.filter((p) => p.builtin);
  const externalPlugins = plugins.filter((p) => !p.builtin);

  const renderCard = (p: PluginInfo) => {
    const commands = commandsOf(p.id);
    const err = p.error ?? runtimeErrors[p.id];
    // webview 入口求值失败时，以"错误"状态展示（Rust 侧不知道前端加载结果）
    const status = runtimeErrors[p.id] ? "error" : p.status;
    return (
      <section className="plugin-card" key={p.id}>
        <div className="plugin-head">
          <div className="plugin-title">
            <h2>{p.name}</h2>
            <span className="badge badge-version">v{p.version}</span>
            <span className="badge badge-runtime">{RUNTIME_LABEL[p.runtime] ?? p.runtime}</span>
            {p.builtin && <span className="badge badge-builtin">核心</span>}
            {p.system && (
              <span className="badge badge-provider" title="数据安全/横切能力，不可禁用">
                系统
              </span>
            )}
            {p.provider && (
              <span
                className="badge badge-provider"
                title="实现 search.provide，启用后进入全局搜索"
              >
                搜索提供者
              </span>
            )}
            {p.theme && (
              <span
                className="badge badge-theme"
                title="皮肤插件：启用后作为主题出现在设置页 → 主题选择器"
              >
                主题
              </span>
            )}
            <span className={`badge badge-status badge-status-${status}`}>
              {STATUS_TEXT[status] ?? status}
            </span>
          </div>
          <div className="plugin-actions">
            {/* 打开界面：插件声明了自带前端（ui）且有导航入口时可用——
                直接跳转到该插件的视图（如文本统计），解决"界面在哪"的发现性问题 */}
            {p.ui && p.nav.length > 0 && (
              <button
                className="btn btn-sm"
                title={`打开「${p.name}」的界面`}
                onClick={() => nav.go(p.nav[0].id as ViewId)}
              >
                打开
              </button>
            )}
            {!p.system && (
              <button
                className="btn btn-sm"
                onClick={() => toggle(p.id, !p.enabled)}
                disabled={busy[p.id] || p.status === "error"}
              >
                {p.enabled ? "禁用" : "启用"}
              </button>
            )}
            <button
              className="btn btn-sm"
              onClick={() => doReload(p.id)}
              disabled={busy[p.id] || !p.enabled}
            >
              重新加载
            </button>
            {!p.system && (
              <button
                className="btn btn-sm danger"
                title={
                  p.builtin
                    ? "卸载：彻底删除 DLL 与目录（随应用分发的资源可重新安装）"
                    : "卸载：删除插件目录（进回收站）"
                }
                aria-label={`卸载插件 ${p.name}`}
                onClick={() => setConfirmDel(p.id)}
                disabled={busy[p.id]}
              >
                <IconTrash width={12} height={12} />
                卸载
              </button>
            )}
          </div>
        </div>

        <p className="plugin-desc">{p.description || "（无描述）"}</p>
        <code className="plugin-id">{p.id}</code>

        {err && (
          <p className="plugin-error" title={err}>
            {err}
          </p>
        )}

        {commands.length > 0 && (
          <div className="plugin-commands">
            <span className="plugin-commands-label">命令</span>
            {commands.map((c) => (
              <CommandTry key={c.id} pluginId={p.id} command={c.id} name={c.name} invoke={invoke} />
            ))}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="plugins-view">
      <header className="view-header">
        <div>
          <h1>插件</h1>
          <p className="view-sub">用 JS / Python 扩展 ToolBox 的能力</p>
        </div>
        <div className="view-actions">
          <button
            className="btn"
            title="安装本地 DLL 插件（.zip 压缩包，含 plugin.json 声明 runtime: native）"
            onClick={() => void pickInstall("zip")}
            disabled={!vault.path || loading}
          >
            安装 .zip
          </button>
          <button
            className="btn"
            title="安装本地 DLL 插件（插件目录，含 plugin.json 声明 runtime: native）"
            onClick={() => void pickInstall("dir")}
            disabled={!vault.path || loading}
          >
            安装目录
          </button>
          <button className="btn" onClick={() => void refresh()} disabled={loading}>
            <IconRefresh width={14} height={14} />
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      {actionError && (
        <div className="empty-state" style={{ marginBottom: 12 }}>
          <p style={{ color: "var(--color-danger, #c0392b)" }}>{actionError}</p>
          <button className="btn btn-sm" onClick={() => setActionError(null)}>
            关闭
          </button>
        </div>
      )}

      {!vault.path ? (
        <div className="empty-state">
          <IconGear width={28} height={28} />
          <p>请先在顶栏选择一个工作区，再管理插件</p>
        </div>
      ) : plugins.length === 0 && !loading ? (
        <div className="empty-state">
          <IconGear width={28} height={28} />
          <p>工作区 plugins 目录下还没有插件</p>
          <code className="hint-path">plugins/&lt;插件id&gt;/plugin.json</code>
        </div>
      ) : (
        <div className="plugin-list">
          <div className="plugin-group-label plugin-mount-hint">
            手动安装本地 DLL 插件：把含 plugin.json（runtime: "native"）的插件目录放入
            <code>%APPDATA%\com.toolbox.desktop\plugins\_core\</code>
            后点「刷新」，自动识别为原生插件并可启用。
            <span style={{ opacity: 0.7 }}>
              原生插件为本地代码，加载即在本机执行，仅安装可信来源。
            </span>
          </div>
          {corePlugins.length > 0 && (
            <div className="plugin-group">
              <div className="plugin-group-label">
                核心插件（随应用分发 · 可启用/禁用/卸载；卸载后从资源一键重新安装）
              </div>
              {corePlugins.map((p) => renderCard(p))}
            </div>
          )}
          {externalPlugins.length > 0 && (
            <div className="plugin-group">
              {corePlugins.length > 0 && <div className="plugin-group-label">外部插件</div>}
              {externalPlugins.map((p) => renderCard(p))}
            </div>
          )}
        </div>
      )}
      {removedCore.length > 0 && (
        <div className="plugin-group" style={{ marginTop: 16 }}>
          <div className="plugin-group-label">已卸载的核心插件（可重新安装）</div>
          {removedCore.map((id) => (
            <section className="plugin-card" key={id}>
              <div className="plugin-head">
                <div className="plugin-title">
                  <h2>{id}</h2>
                  <span className="badge badge-runtime">原生</span>
                  <span className="badge badge-status badge-status-stopped">已卸载</span>
                </div>
                <div className="plugin-actions">
                  <button
                    className="btn btn-sm"
                    onClick={() => void doReinstall(id)}
                    disabled={busy[id]}
                  >
                    {busy[id] ? "恢复中…" : "重新安装"}
                  </button>
                </div>
              </div>
              <p className="plugin-desc">
                已彻底删除（DLL 与目录）。重新安装将从随应用分发的资源恢复并启用。
              </p>
            </section>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title="卸载插件"
        message={
          confirmDel
            ? plugins.find((p) => p.id === confirmDel)?.builtin
              ? `确定卸载核心插件「${confirmDel}」？将彻底删除 DLL 与目录（不进回收站）；需要时可在本页「已卸载的核心插件」中一键重新安装。`
              : `确定卸载插件「${confirmDel}」？插件目录将移入系统回收站，启用状态一并清除。`
            : ""
        }
        confirmText="卸载"
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => {
          if (confirmDel) void doUninstall(confirmDel);
          setConfirmDel(null);
        }}
      />

      <ConfirmDialog
        open={pendingInstall !== null}
        title="安装原生插件"
        message={
          pendingInstall
            ? `将从「${pendingInstall.path}」安装 DLL 插件。原生插件为本地代码，加载即在本机执行（等同运行任意程序）——请确认来源可信。`
            : ""
        }
        confirmText="安装"
        danger
        onCancel={() => setPendingInstall(null)}
        onConfirm={() => void doInstall()}
      />

      {/* 事件桥日志：进程插件实时推送的事件（Notification） */}
      {events.length > 0 && (
        <div className="plugin-events">
          <div className="plugin-events-head">
            <span>插件事件（实时）</span>
            <button
              className="icon-btn sm"
              title="清空事件日志"
              aria-label="清空事件日志"
              onClick={() => setEvents([])}
            >
              <IconTrash width={12} height={12} />
            </button>
          </div>
          <div className="plugin-events-list">
            {events
              .slice(-15)
              .reverse()
              .map((e, i) => (
                <div key={i} className="plugin-event">
                  <span className="plugin-event-time">{fmtTime(e.time)}</span>
                  <span className="plugin-event-id">{e.pluginId}</span>
                  <span className="plugin-event-name">{e.event}</span>
                  <code className="plugin-event-data">{JSON.stringify(e.data)}</code>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
