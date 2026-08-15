import { useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  IconBraces,
  IconClock,
  IconCopy,
  IconEnter,
  IconHash,
  IconText,
} from "../components/icons";

/**
 * M3 内置数据工具（纯前端实现，不依赖插件运行时）。
 * 工具 = 元数据 + 组件；工具视图按需渲染。
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

/* ---------------- JSON 格式化 ---------------- */

function JsonTool() {
  const [text, setText] = useState("");
  const [indent, setIndent] = useState<2 | 4>(2);
  const [minify, setMinify] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopy();

  useEffect(() => {
    setError(null);
    if (!text.trim()) {
      setOutput("");
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setOutput(
        minify ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indent)
      );
    } catch (e) {
      setOutput("");
      setError(`JSON 解析失败：${String(e)}`);
    }
  }, [text, indent, minify]);

  return (
    <div className="tool-box">
      <div className="tool-options">
        <span className="tool-option">
          缩进
          <label className="segmented segmented-sm">
            {[2, 4].map((n) => (
              <button
                key={n}
                className={`segmented-item${indent === n ? " active" : ""}`}
                onClick={() => setIndent(n as 2 | 4)}
              >
                {n}
              </button>
            ))}
          </label>
        </span>
        <label className="tool-check">
          <input
            type="checkbox"
            checked={minify}
            onChange={(e) => setMinify(e.target.checked)}
          />
          压缩为单行
        </label>
      </div>
      <textarea
        className="tool-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder='{"name": "ToolBox", "tags": ["笔记", "工具"]}'
      />
      <ToolOutput output={output} error={error} copied={copied} onCopy={() => copy(output)} />
    </div>
  );
}

/* ---------------- 时间戳转换 ---------------- */

function parseTimestamp(input: string): { ms: number; kind: string } | null {
  const t = input.trim();
  if (!t) return null;
  if (/^\d{10}$/.test(t)) return { ms: Number(t) * 1000, kind: "Unix 秒" };
  if (/^\d{13}$/.test(t)) return { ms: Number(t), kind: "Unix 毫秒" };
  const d = new Date(t);
  if (!Number.isNaN(d.getTime()) && /^\d{4}/.test(t)) {
    return { ms: d.getTime(), kind: "日期时间" };
  }
  return null;
}

function relative(ms: number, nowMs: number): string {
  const diff = nowMs - ms;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "前" : "后";
  if (abs < 60_000) return `${Math.floor(abs / 1000)} 秒${suffix}`;
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)} 分钟${suffix}`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)} 小时${suffix}`;
  return `${Math.floor(abs / 86_400_000)} 天${suffix}`;
}

function TimestampTool() {
  const [input, setInput] = useState("");
  const { copied, copy } = useCopy();

  const parsed = useMemo(() => parseTimestamp(input), [input]);
  const fmt = (ms: number) =>
    new Date(ms).toLocaleString("zh-CN", { hour12: false });
  const iso = (ms: number) => new Date(ms).toISOString();

  const rows = parsed
    ? [
        ["识别类型", parsed.kind],
        ["ISO 格式", iso(parsed.ms)],
        ["本地时间", fmt(parsed.ms)],
        ["Unix 秒", String(Math.floor(parsed.ms / 1000))],
        ["Unix 毫秒", String(parsed.ms)],
        ["相对时间", relative(parsed.ms, Date.now())],
      ]
    : [];

  const allText = rows.map(([k, v]) => `${k}: ${v}`).join("\n");

  return (
    <div className="tool-box">
      <div className="tool-options">
        <input
          className="tool-input-single"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="时间戳（秒/毫秒）或日期，如 1735689600 或 2025-01-01 08:00:00"
          spellCheck={false}
        />
        <button
          className="btn btn-sm"
          onClick={() => setInput(String(Date.now()))}
        >
          使用当前时间
        </button>
      </div>
      {parsed ? (
        <div className="ts-rows">
          {rows.map(([k, v]) => (
            <div className="ts-row" key={k}>
              <span className="ts-key">{k}</span>
              <code className="ts-value">{v}</code>
            </div>
          ))}
        </div>
      ) : (
        <div className="tool-result empty">
          {input.trim() ? "无法识别：支持 10 位秒 / 13 位毫秒 / 日期时间字符串" : "输入时间戳或日期"}
        </div>
      )}
      <div className="tool-output-actions">
        <button
          className="btn btn-sm"
          onClick={() => copy(allText)}
          disabled={!parsed}
        >
          <IconCopy width={12} height={12} />
          {copied ? "已复制" : "复制全部"}
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

/* ---------------- UUID 生成 ---------------- */

function UuidTool() {
  const [count, setCount] = useState(1);
  const [upper, setUpper] = useState(false);
  const [output, setOutput] = useState("");
  const { copied, copy } = useCopy();

  const generate = () => {
    const n = Math.min(Math.max(Math.floor(count) || 1, 1), 50);
    const list = Array.from({ length: n }, () => {
      const u = crypto.randomUUID();
      return upper ? u.toUpperCase() : u;
    });
    setOutput(list.join("\n"));
  };

  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, upper]);

  return (
    <div className="tool-box">
      <div className="tool-options">
        <span className="tool-option">
          数量
          <input
            className="tool-input-num"
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </span>
        <label className="tool-check">
          <input
            type="checkbox"
            checked={upper}
            onChange={(e) => setUpper(e.target.checked)}
          />
          大写
        </label>
      </div>
      <pre className="tool-result ok uuid-output">{output}</pre>
      <div className="tool-output-actions">
        <button className="btn btn-sm" onClick={generate}>
          重新生成
        </button>
        <button className="btn btn-sm" onClick={() => copy(output)} disabled={!output}>
          <IconCopy width={12} height={12} />
          {copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 行尾转换 ---------------- */

function EolTool() {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"LF" | "CRLF" | "CR">("LF");
  const { copied, copy } = useCopy();

  const stats = useMemo(() => {
    const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return {
      lines: norm ? norm.split("\n").length : 0,
      lf: (norm.match(/\n/g) ?? []).length,
      crlf: (text.match(/\r\n/g) ?? []).length,
      cr: (text.match(/(?<!\r)\r(?!\n)/g) ?? []).length,
    };
  }, [text]);

  const output = useMemo(() => {
    const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (target === "LF") return norm;
    if (target === "CRLF") return norm.replace(/\n/g, "\r\n");
    return norm.replace(/\n/g, "\r");
  }, [text, target]);

  return (
    <div className="tool-box">
      <div className="tool-options">
        <span className="tool-option">
          目标行尾
          <label className="segmented segmented-sm">
            {(["LF", "CRLF", "CR"] as const).map((t) => (
              <button
                key={t}
                className={`segmented-item${target === t ? " active" : ""}`}
                onClick={() => setTarget(t)}
              >
                {t}
              </button>
            ))}
          </label>
        </span>
        <span className="tool-meta">
          {stats.lines} 行 · LF×{stats.lf} · CRLF×{stats.crlf} · CR×{stats.cr}
        </span>
      </div>
      <textarea
        className="tool-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder="粘贴要转换行尾的文本…"
      />
      <ToolOutput output={output} error={null} copied={copied} onCopy={() => copy(output)} />
    </div>
  );
}

/* ---------------- 注册表 ---------------- */

export const TOOLS: ToolDef[] = [
  {
    id: "json",
    name: "JSON 格式化",
    desc: "美化 / 压缩 JSON，缩进可选",
    icon: IconBraces,
    Component: JsonTool,
  },
  {
    id: "timestamp",
    name: "时间戳转换",
    desc: "秒 / 毫秒 / 日期互转，附相对时间",
    icon: IconClock,
    Component: TimestampTool,
  },
  {
    id: "base64",
    name: "Base64",
    desc: "文本 ↔ Base64（UTF-8 安全）",
    icon: IconText,
    Component: Base64Tool,
  },
  {
    id: "uuid",
    name: "UUID 生成",
    desc: "批量生成 v4 UUID，可转大写",
    icon: IconHash,
    Component: UuidTool,
  },
  {
    id: "eol",
    name: "行尾转换",
    desc: "LF / CRLF / CR 互转，附行统计",
    icon: IconEnter,
    Component: EolTool,
  },
];
