import type { KeyboardEvent } from "react";

/**
 * 让 `role="button"` 的可点击容器（div）支持 Enter/Space 触发。
 * 仅当焦点在容器本身时生效（e.target === currentTarget）：
 * 行内若还有真正的 <button>（如删除），其键盘事件不会被误拦截。
 */
export const onRowKeyDown = (e: KeyboardEvent, activate: () => void) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    activate();
  }
};
