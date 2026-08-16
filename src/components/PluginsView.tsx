import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { usePlugins } from "../core/plugins";
import { useVault } from "../core/vault";
import type { PluginInfo } from "../core/api";
import { CommandTry } from "./CommandTry";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconGear, IconRefresh, IconTrash } from "./icons";

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
  const [events, setEvents] = useState<PluginEventLog[]>([]);
  /** 操作错误提示（卸载/切换/重载失败时显示，可关闭）——此前仅 console.error 用户无感知 */
  const [actionError, setActionError] = useState<string | null>(null);

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
            <span className={`badge badge-status badge-status-${status}`}>
              {STATUS_TEXT[status] ?? status}
            </span>
          </div>
          <div className="plugin-actions">
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
            {!p.builtin && (
              <button
                className="btn btn-sm danger"
                title="卸载：删除插件目录（进回收站）"
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
          {corePlugins.length > 0 && (
            <div className="plugin-group">
              <div className="plugin-group-label">
                核心插件（随应用分发 · 可启用/禁用，不可卸载）
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
      <ConfirmDialog
        open={confirmDel !== null}
        title="卸载插件"
        message={
          confirmDel
            ? `确定卸载插件「${confirmDel}」？插件目录将移入系统回收站，启用状态一并清除。`
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
