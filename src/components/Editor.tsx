import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";

interface EditorProps {
  doc: string;
  onChange: (doc: string) => void;
  onSave: () => void;
  dark: boolean;
  placeholderText?: string;
}

/**
 * CodeMirror 6 Markdown 编辑器。
 * 组件以 key 重建（切换文件/主题时由父级传新 key），
 * 挂载时一次性初始化，文档变化经 onChange 反馈给 Vault 状态层。
 */
export function Editor({ doc, onChange, onSave, dark, placeholderText }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const state = EditorState.create({
      doc,
      extensions: [
        history(),
        markdown(),
        syntaxHighlighting(toolHighlight, { fallback: true }),
        highlightSelectionMatches(),
        keymap.of([
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
          { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
        ]),
        EditorView.lineWrapping,
        cmPlaceholder(placeholderText ?? ""),
        editorTheme(dark),
      ],
    });

    const view = new EditorView({
      state,
      parent: host,
      dispatch: (tr, v) => {
        v.update([tr]);
        if (tr.docChanged) onChangeRef.current(v.state.doc.toString());
      },
    });

    // 视口出现时聚焦，方便直接开写
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
    };
    // 组件按 key 重建：仅在挂载时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}

/* Markdown 语法着色：全部取设计令牌，随主题自动变化 */
const toolHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.55em", fontWeight: "700", color: "var(--fg)" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700", color: "var(--fg)" },
  { tag: tags.heading3, fontSize: "1.12em", fontWeight: "650", color: "var(--fg)" },
  { tag: tags.strong, fontWeight: "700", color: "var(--fg)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent-strong)", textDecoration: "underline" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)", fontSize: "0.92em", background: "var(--bg-soft)", color: "var(--accent-strong)", padding: "0 4px", borderRadius: "4px" },
  { tag: tags.quote, color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.meta, color: "var(--fg-faint)" },
  { tag: tags.processingInstruction, color: "var(--fg-faint)" },
  { tag: tags.list, color: "var(--accent)" },
  { tag: tags.comment, color: "var(--fg-faint)" },
]);

function editorTheme(dark: boolean) {
  return EditorView.theme(
    {
      "&": {
        height: "100%",
        backgroundColor: "var(--bg-elevated)",
        color: "var(--fg)",
        fontSize: "14px",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-sans)",
        lineHeight: "1.75",
        overflow: "auto",
      },
      ".cm-content": {
        padding: "20px 28px 45vh",
        maxWidth: "860px",
        caretColor: "var(--accent)",
      },
      ".cm-line": { padding: "0" },
      "&.cm-focused": { outline: "none" },
      ".cm-selectionBackground": { background: "var(--accent-soft)" },
      "&.cm-focused .cm-selectionBackground": { background: "var(--accent-soft)" },
      ".cm-cursor": { borderLeftColor: "var(--accent)" },
      ".cm-placeholder": { color: "var(--fg-faint)" },
      ".cm-searchMatch": {
        backgroundColor: "var(--pastel-yellow-bg)",
        outline: "1px solid var(--pastel-yellow-fg)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "var(--pastel-blue-bg)",
      },
      ".cm-panels": {
        backgroundColor: "var(--bg-soft)",
        color: "var(--fg)",
        borderBottom: "1px solid var(--border)",
        fontFamily: "var(--font-mono)",
        fontSize: "12px",
      },
      ".cm-panels input": {
        fontFamily: "var(--font-mono)",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        color: "var(--fg)",
        borderRadius: "4px",
        padding: "2px 6px",
      },
      ".cm-panels button": {
        fontFamily: "var(--font-mono)",
        background: "var(--bg-soft)",
        border: "1px solid var(--border)",
        borderRadius: "4px",
        cursor: "pointer",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        color: "var(--fg)",
      },
    },
    { dark }
  );
}
