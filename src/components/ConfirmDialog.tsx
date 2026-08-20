import { useEffect, useRef } from "react";

/**
 * 应用内确认对话框：替换原生 window.confirm（系统样式、阻塞、暗色下刺眼）。
 * 用法：视图持有 open state，确认后调用回调并关闭。
 * 无障碍：Esc 关闭（与取消等价）、焦点收在对话框内、关闭后焦点归还触发元素。
 */
interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // 打开时记录焦点触发元素，关闭后归还（键盘用户不会丢失焦点位置）
  const restoreRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Esc 关闭（与取消等价）；打开时取消按钮获得焦点（安全默认：回车不误触发危险操作）
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      restoreRef.current?.focus?.();
      restoreRef.current = null;
    };
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="confirm-overlay"
      onClick={onCancel}
      // 焦点陷阱：Tab 在对话框内循环（轻量实现，避免引入焦点管理库）
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const el = dialogRef.current;
        if (!el) return;
        const focusables = el.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel}>
            {cancelText}
          </button>
          <button className={`btn${danger ? " btn-danger" : ""}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
