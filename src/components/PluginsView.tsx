import { useState } from "react";
import { usePlugins } from "../core/plugins";
import { useVault } from "../core/vault";
import { CommandTry } from "./CommandTry";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconGear, IconRefresh, IconTrash } from "./icons";

const RUNTIME_LABEL: Record<string, string> = {
  webview: "JS",
  process: "Python",
};

const STATUS_TEXT: Record<string, string> = {
  ready: "就绪",
  stopped: "已停止",
  error: "错误",
};

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

  const doUninstall = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await uninstall(id);
    } catch (e) {
      console.error("[plugins] 卸载失败", e);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await setEnabled(id, enabled);
    } catch (e) {
      console.error("[plugins] 切换失败", e);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const doReload = async (id: string) => {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await reload(id);
    } catch (e) {
      console.error("[plugins] 重载失败", e);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
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
          {plugins.map((p) => {
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
                    <span className={`badge badge-status badge-status-${status}`}>
                      {STATUS_TEXT[status] ?? status}
                    </span>
                  </div>
                  <div className="plugin-actions">
                    <button
                      className="btn btn-sm"
                      onClick={() => toggle(p.id, !p.enabled)}
                      disabled={busy[p.id] || p.status === "error"}
                    >
                      {p.enabled ? "禁用" : "启用"}
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => doReload(p.id)}
                      disabled={busy[p.id] || !p.enabled}
                    >
                      重新加载
                    </button>
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
                      <CommandTry
                        key={c.id}
                        pluginId={p.id}
                        command={c.id}
                        name={c.name}
                        invoke={invoke}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
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
    </div>
  );
}
