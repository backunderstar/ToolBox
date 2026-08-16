import { useEffect, useState } from "react";
import {
  applyTheme,
  applyThemeStyle,
  upsertCustomTheme,
  EDITABLE_TOKENS,
  type ThemeDef,
  type ThemeMode,
} from "../themes/themes";

/**
 * 主题编辑器（M5）：基于某主题副本调色，实时预览，保存为自定义主题。
 * 预览走 applyThemeStyle（不持久化）；保存时 upsertCustomTheme + applyTheme。
 */
export function ThemeEditor({
  initial,
  onCancel,
  onSaved,
}: {
  initial: ThemeDef;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [draft, setDraft] = useState<ThemeDef>(initial);
  const [name, setName] = useState(initial.name);

  /* 实时预览（不持久化） */
  useEffect(() => {
    applyThemeStyle(draft.base, draft.id, draft.tokens);
  }, [draft]);

  const setToken = (key: string, value: string) =>
    setDraft((d) => ({ ...d, tokens: { ...d.tokens, [key]: value } }));

  const setBase = (base: ThemeMode) => setDraft((d) => ({ ...d, base }));

  const save = () => {
    const def: ThemeDef = {
      ...draft,
      name: name.trim() || "未命名主题",
      custom: true,
    };
    upsertCustomTheme(def);
    applyTheme(def.id);
    onSaved(def.id);
  };

  const tokenValue = (key: string): string => {
    if (draft.tokens[key]) return draft.tokens[key];
    // 回退到当前计算样式，保证 color input 有初值
    return getComputedStyle(document.documentElement).getPropertyValue(key).trim();
  };

  return (
    <div className="theme-editor">
      <div className="theme-editor-head">
        <input
          className="theme-editor-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="主题名称"
          spellCheck={false}
        />
        <span className="tool-option">
          底色
          <label className="segmented segmented-sm">
            {(
              [
                ["light", "亮"],
                ["dark", "暗"],
              ] as const
            ).map(([b, label]) => (
              <button
                key={b}
                className={`segmented-item${draft.base === b ? " active" : ""}`}
                onClick={() => setBase(b)}
              >
                {label}
              </button>
            ))}
          </label>
        </span>
      </div>

      <div className="theme-editor-tokens">
        {EDITABLE_TOKENS.map(({ key, label }) => (
          <label className="theme-token-row" key={key}>
            <span className="theme-token-label">
              {label}
              <code className="theme-token-key">{key}</code>
            </span>
            <input
              type="color"
              className="theme-token-input"
              value={normalizeHex(tokenValue(key))}
              onChange={(e) => setToken(key, e.target.value)}
            />
            <code className="theme-token-value">{tokenValue(key)}</code>
          </label>
        ))}
      </div>

      <div className="theme-editor-actions">
        <button className="btn btn-sm" onClick={save}>
          保存主题
        </button>
        <button className="btn btn-sm" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

/** 把 css 颜色（#rgb/#rrggbb/rgb()/rgba()）统一转成 #rrggbb；无法解析时返回 fallback */
function normalizeHex(value: string, fallback = "#000000"): string {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${Array.from(v.slice(1))
      .map((c) => c + c)
      .join("")}`;
  }
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  if (m) {
    return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  }
  return fallback;
}
