import { useEffect, useRef } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";

interface EditorProps {
  doc: string;
  onChange: (doc: string) => void;
  onSave: () => void;
  dark: boolean;
  placeholderText?: string;
}

/**
 * 极简工具栏：撤销/重做、标题、行内格式、列表、引用/代码/表格、模式切换与全屏。
 * 上传、表情、大纲、字数统计等一律关闭，保持界面克制。
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
  "fullscreen",
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

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
      toolbar: TOOLBAR,
      input: (value) => onChangeRef.current(value),
      blur: () => onSaveRef.current(),
      after: () => {
        requestAnimationFrame(() => vd.focus());
      },
    });

    return () => {
      vd.destroy();
    };
    // 组件按 key 重建：仅在挂载时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}
