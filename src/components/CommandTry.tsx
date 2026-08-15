import { useState } from "react";
import { IconPlus } from "./icons";

/**
 * 插件命令试用组件：命令胶囊 + 展开的 JSON 参数台。
 * 在插件管理页与数据工具页共用；invoke 由调用方注入（mock / 真实路由）。
 */

/** 常用示例命令的默认测试参数 */
export const EXAMPLE_ARGS: Record<string, string> = {
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

interface CommandTryProps {
  pluginId: string;
  command: string;
  name: string;
  invoke: (pluginId: string, command: string, args: unknown) => Promise<unknown>;
}

export function CommandTry({ pluginId, command, name, invoke }: CommandTryProps) {
  const [open, setOpen] = useState(false);
  const [argsText, setArgsText] = useState(EXAMPLE_ARGS[`${pluginId}:${command}`] ?? "{}");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [running, setRunning] = useState(false);

  const toggle = () => {
    setOpen((o) => !o);
    setResult(null);
    if (!open) {
      setArgsText(EXAMPLE_ARGS[`${pluginId}:${command}`] ?? "{}");
    }
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    try {
      let args: unknown = {};
      if (argsText.trim()) {
        args = JSON.parse(argsText);
      }
      const out = await invoke(pluginId, command, args);
      setResult({ ok: true, text: JSON.stringify(out, null, 2) });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <span className="command-chip">
        <span className="command-name">{name}</span>
        <button
          className="command-try"
          onClick={toggle}
          title={`${open ? "收起" : "调用"} ${command}`}
          aria-label={`${open ? "收起" : "调用"} ${command}`}
          aria-expanded={open}
        >
          <IconPlus width={11} height={11} />
          {open ? "收起" : "试用"}
        </button>
      </span>
      {open && (
        <div className="try-panel">
          <div className="try-head">
            <span className="try-title">
              调用命令 <code>{command}</code>
            </span>
            <button className="btn btn-sm" onClick={run} disabled={running}>
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
    </>
  );
}
