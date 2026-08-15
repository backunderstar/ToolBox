import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { IconCopy, IconText } from "../components/icons";

/**
 * M3 内置数据工具（纯前端实现，不依赖插件运行时）。
 * 工具 = 元数据 + 组件；工具视图按需渲染。
 * 注：JSON 格式化 / 时间戳 / UUID / 行尾转换已按需求移除，保留 Base64。
 */

export interface ToolDef {
  id: string;
  name: string;
  desc: string;
  icon: ComponentType<{ width?: number; height?: number; className?: string }>;
  Component: ComponentType;
}

/* ---------------- 共享小件 ---------------- */

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用（非安全上下文）时静默 */
    }
  };
  return { copied, copy };
}

function ToolOutput({
  output,
  error,
  copied,
  onCopy,
  placeholder = "结果将显示在这里",
}: {
  output: string;
  error: string | null;
  copied: boolean;
  onCopy: () => void;
  placeholder?: string;
}) {
  return (
    <div className="tool-output">
      {error ? (
        <pre className="tool-result err">{error}</pre>
      ) : output ? (
        <pre className="tool-result ok">{output}</pre>
      ) : (
        <div className="tool-result empty">{placeholder}</div>
      )}
      <div className="tool-output-actions">
        <button className="btn btn-sm" onClick={onCopy} disabled={!output || !!error}>
          <IconCopy width={12} height={12} />
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- Base64 ---------------- */

function Base64Tool() {
  const [mode, setMode] = useState<"encode" | "decode">("encode");
  const [text, setText] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopy();

  useEffect(() => {
    setError(null);
    if (!text) {
      setOutput("");
      return;
    }
    try {
      if (mode === "encode") {
        const bytes = new TextEncoder().encode(text);
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        setOutput(btoa(bin));
      } else {
        const bin = atob(text.trim());
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        setOutput(new TextDecoder().decode(bytes));
      }
    } catch (e) {
      setOutput("");
      setError(`Base64 解码失败：${String(e)}`);
    }
  }, [text, mode]);

  return (
    <div className="tool-box">
      <div className="tool-options">
        <span className="tool-option">方向</span>
        <label className="segmented segmented-sm">
          {(
            [
              ["encode", "编码"],
              ["decode", "解码"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              className={`segmented-item${mode === m ? " active" : ""}`}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </label>
      </div>
      <textarea
        className="tool-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder={mode === "encode" ? "要编码的文本…" : "要解码的 Base64 字符串…"}
      />
      <ToolOutput output={output} error={error} copied={copied} onCopy={() => copy(output)} />
    </div>
  );
}

/* ---------------- 注册表 ---------------- */

export const TOOLS: ToolDef[] = [
  {
    id: "base64",
    name: "Base64",
    desc: "文本 ↔ Base64（UTF-8 安全）",
    icon: IconText,
    Component: Base64Tool,
  },
];
