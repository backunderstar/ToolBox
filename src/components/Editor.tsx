import { useEffect, useRef, useState } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import { aiChat } from "../core/api";

/** Vditor 实例的结构子集（工具栏回调用到的 API） */
type VdLike = {
  getSelection: () => string;
  replaceSelection: (value: string) => void;
  tip: (text: string, time?: number) => void;
};

interface EditorProps {
  doc: string;
  onChange: (doc: string) => void;
  onSave: () => void;
  dark: boolean;
  placeholderText?: string;
}

/**
 * 极简工具栏：撤销/重做、标题、行内格式、列表、引用/代码/表格、AI 摘要、模式切换。
 * 上传、表情、大纲、字数统计等一律关闭，保持界面克制；
 * 全屏按钮与应用的"专注模式"重复，一并去掉以压缩工具栏宽度（保证最小窗口下单行显示）。
 */
const TOOLBAR = [
  "undo",
  "redo",
  "|",
  "headings",
  "bold",
  "italic",
  "strike",
  "|",
  "list",
  "ordered-list",
  "check",
  "|",
  "quote",
  "inline-code",
  "code",
  "link",
  "table",
  "|",
  "edit-mode",
];

/**
 * Vditor 即时渲染（IR）Markdown 编辑器（Typora 式边写边渲染）。
 * 组件以 key 重建（切换文件/主题时由父级传新 key），挂载时一次性初始化。
 * - 输入实时经 onChange 反馈给 Vault 状态层（防抖自动保存）
 * - 失焦触发 onSave（即时落盘）
 * - 资源全部本地化（public/vditor），离线可用
 */
export function Editor({ doc, onChange, onSave, dark, placeholderText }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  /* busy 状态用 ref 供挂载期闭包（toolbar click）读取，避免死代码防抖 */
  const aiBusyRef = useRef(false);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  /* M6：选中文本 → AI 摘要 → 以引用块替换选区 */
  const handleAiSummary = async (vd: VdLike) => {
    if (aiBusyRef.current) return;
    const sel = vd.getSelection();
    if (!sel?.trim()) {
      vd.tip("请先在编辑器中选中要摘要的文本", 2000);
      return;
    }
    aiBusyRef.current = true;
    setAiBusy(true);
    try {
      const reply = await aiChat([
        {
          role: "system",
          content: "你是精炼的摘要助手。用 3-5 条要点总结用户文本，使用中文，只输出摘要。",
        },
        { role: "user", content: sel.slice(0, 6000) },
      ]);
      const block = `\n\n> **AI 摘要**\n${reply
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}\n`;
      vd.replaceSelection(block);
    } catch (e) {
      const msg = String(e);
      vd.tip(
        msg.includes("未配置 API Key") ? "未配置 AI —— 请到设置页填写" : msg.slice(0, 80),
        3000
      );
    } finally {
      aiBusyRef.current = false;
      setAiBusy(false);
    }
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    try {
      const vd = new Vditor(host, {
        height: "100%",
        mode: "ir",
        theme: dark ? "dark" : "classic",
        lang: "zh_CN",
        icon: "ant",
        cdn: "/vditor",
        placeholder: placeholderText ?? "",
        value: doc,
        cache: { enable: false },
        counter: { enable: false },
        outline: { enable: false, position: "right" },
        toolbar: [
          ...TOOLBAR,
          "|",
          {
            name: "ai-summary",
            icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l1.9 5.6 5.6 1.9-5.6 1.9L12 18.5l-1.9-5.6L4.5 11l5.6-1.9z"/></svg>',
            tip: aiBusy ? "AI 摘要生成中…" : "AI 摘要（选中文本）",
            click: (_event: Event, vditor: unknown) => {
              void handleAiSummary(vditor as VdLike);
            },
          },
        ],
        input: (value) => onChangeRef.current(value),
        blur: () => onSaveRef.current(),
        after: () => {
          const raf = requestAnimationFrame(() => {
            try {
              vd.focus();
            } catch {
              /* 编辑器可能已在下一帧前销毁 */
            }
          });
          // 记录句柄以便卸载时取消
          (vd as unknown as { __raf?: number }).__raf = raf;
        },
      });

      return () => {
        try {
          const raf = (vd as unknown as { __raf?: number }).__raf;
          if (raf) cancelAnimationFrame(raf);
          vd.destroy();
        } catch (e) {
          console.error("[vditor-destroy]", e);
        }
      };
    } catch (e) {
      console.error("[vditor-init]", e);
      setInitError(e instanceof Error ? e.message : String(e));
    }
    // 组件按 key 重建：仅在挂载时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (initError) {
    return (
      <div className="editor-error">
        <p>编辑器初始化失败：</p>
        <pre>{initError}</pre>
      </div>
    );
  }

  return <div className="editor-host" ref={hostRef} />;
}
