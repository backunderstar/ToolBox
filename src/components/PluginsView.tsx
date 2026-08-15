import { useState } from "react";
import { usePlugins } from "../core/plugins";
import { useVault } from "../core/vault";
import { IconGear, IconRefresh, IconPlus } from "./icons";

/** 示例命令的默认测试参数（让两个示例插件开箱即用） */
const EXAMPLE_ARGS: Record<string, string> = {
  "text-stats:analyze": JSON.stringify(
    { text: "你好，世界！\n这是第二行。\n\n新段落开始。" },
    null,
    2
  ),
  "csv-tool:csv.convert": JSON.stringify(
    { csv: "名称,数量\n苹果,3\n香蕉,5", format: "json" },
    null,
    2
  ),
};

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
  const { plugins, loading, runtimeErrors, refresh, setEnabled, reload, invoke, commandsOf } =
    usePlugins();

  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [tryPanel, setTryPanel] = useState<{ pluginId: string; command: string } | null>(null);
  const [argsText, setArgsText] = useState("{}");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!tryPanel || running) return;
    setRunning(true);
    setResult(null);
    try {
      let args: unknown = {};
      if (argsText.trim()) {
        args = JSON.parse(argsText);
      }
      const out = await invoke(tryPanel.pluginId, tryPanel.command, args);
      setResult({ ok: true, text: JSON.stringify(out, null, 2) });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setRunning(false);
    }
  };

  const openTry = (pluginId: string, command: string) => {
    setTryPanel({ pluginId, command });
    setArgsText(EXAMPLE_ARGS[`${pluginId}:${command}`] ?? "{}");
    setResult(null);
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

  const doRefresh = async () => {
    setResult(null);
    await refresh();
  };

  return (
    <div className="plugins-view scroll-area">
      <header className="view-header">
        <div>
          <h1>插件</h1>
          <p className="view-sub">用 JS / Python 扩展 ToolBox 的能力</p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={doRefresh} disabled={loading}>
            <IconRefresh width={14} height={14} />
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      {!vault.path ? (
        <div className="empty-state">
          <IconGear width={28} height={28} />
          <p>请先在上方选择一个工作区，再管理插件</p>
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
            return (
              <section className="plugin-card" key={p.id}>
                <div className="plugin-head">
                  <div className="plugin-title">
                    <h2>{p.name}</h2>
                    <span className="badge badge-version">v{p.version}</span>
                    <span className="badge badge-runtime">{RUNTIME_LABEL[p.runtime] ?? p.runtime}</span>
                    <span className={`badge badge-status badge-status-${p.status}`}>
                      {STATUS_TEXT[p.status] ?? p.status}
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
                      <span key={c.id} className="command-chip">
                        <span className="command-name">{c.name}</span>
                        <button
                          className="command-try"
                          onClick={() => openTry(p.id, c.id)}
                          title={`调用 ${c.id}`}
                        >
                          <IconPlus width={11} height={11} />
                          试用
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {tryPanel?.pluginId === p.id && (
                  <div className="try-panel">
                    <div className="try-head">
                      <span className="try-title">
                        试用命令 <code>{tryPanel.command}</code>
                      </span>
                      <button
                        className="btn btn-sm"
                        onClick={run}
                        disabled={running}
                      >
                        {running ? "运行中…" : "运行"}
                      </button>
                    </div>
                    <textarea
                      className="try-args"
                      value={argsText}
                      onChange={(e) => setArgsText(e.target.value)}
                      spellCheck={false}
                      placeholder='JSON 参数，如 {"text": "你好"}'
                    />
                    {result && (
                      <pre className={`try-result ${result.ok ? "ok" : "err"}`}>
                        {result.text}
                      </pre>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
