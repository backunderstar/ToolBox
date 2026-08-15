import { useState } from "react";
import { TOOLS } from "../tools/registry";
import type { ToolDef } from "../tools/registry";
import { usePlugins } from "../core/plugins";
import { CommandTry } from "./CommandTry";
import { IconArrowLeft } from "./icons";

/**
 * 数据工具视图（M3）：
 * - 内置工具：JSON / 时间戳 / Base64 / UUID / 行尾（纯前端）
 * - 插件命令：已启用插件声明的命令（如 csv.convert、文本统计）
 */
export function ToolsView() {
  const { plugins, commandsOf, invoke } = usePlugins();
  const [active, setActive] = useState<ToolDef | null>(null);

  const pluginCommands = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      plugin: p,
      commands: commandsOf(p.id),
    }))
    .filter((x) => x.commands.length > 0);

  return (
    <div className="tools-view scroll-area">
      <header className="view-header">
        <div>
          <h1>数据工具</h1>
          <p className="view-sub">内置实用工具 + 已启用插件的命令</p>
        </div>
      </header>

      {active ? (
        /* ---- 工具台 ---- */
        <div className="tool-workspace">
          <div className="tool-workspace-head">
            <button className="btn btn-sm" onClick={() => setActive(null)}>
              <IconArrowLeft width={13} height={13} />
              全部工具
            </button>
            <h2 className="tool-workspace-title">{active.name}</h2>
          </div>
          <active.Component />
        </div>
      ) : (
        <>
          {/* ---- 内置工具 ---- */}
          <section>
            <h2 className="section-title">内置工具</h2>
            <div className="module-grid tool-grid">
              {TOOLS.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    className="tool-card"
                    onClick={() => setActive(t)}
                  >
                    <Icon className="module-icon" width={20} height={20} />
                    <span className="tool-card-name">{t.name}</span>
                    <span className="tool-card-desc">{t.desc}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ---- 插件命令 ---- */}
          <section className="tools-plugins">
            <h2 className="section-title">插件命令</h2>
            {pluginCommands.length === 0 ? (
              <div className="tool-result empty">
                暂无已启用的插件命令 —— 在「插件」页启用插件后，其命令会出现在这里
              </div>
            ) : (
              <div className="plugin-list">
                {pluginCommands.map(({ plugin, commands }) => (
                  <section className="plugin-card" key={plugin.id}>
                    <div className="plugin-head">
                      <div className="plugin-title">
                        <h2>{plugin.name}</h2>
                        <span className="badge badge-version">v{plugin.version}</span>
                        <span className="badge badge-runtime">
                          {plugin.runtime === "webview" ? "JS" : "Python"}
                        </span>
                      </div>
                    </div>
                    <div className="plugin-commands">
                      <span className="plugin-commands-label">命令</span>
                      {commands.map((c) => (
                        <CommandTry
                          key={c.id}
                          pluginId={plugin.id}
                          command={c.id}
                          name={c.name}
                          invoke={invoke}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
