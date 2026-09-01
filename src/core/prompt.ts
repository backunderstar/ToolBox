import { defineComponent, h, reactive } from "vue";
import PromptDialog from "../components/PromptDialog.vue";

export interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  confirmText?: string;
  cancelText?: string;
}

interface PromptStore extends Required<PromptOptions> {
  open: boolean;
  resolve: (value: string | null) => void;
}

// 模块级单例状态（与 vault.ts / plugins.ts 同模式）：任何视图调用 askPrompt 即弹一个统一
// 风格的输入对话框，比原生 window.prompt 暗色一致、不阻塞、可 Esc。
const store: PromptStore = reactive({
  open: false,
  title: "",
  message: "",
  placeholder: "",
  initial: "",
  confirmText: "确认",
  cancelText: "取消",
  resolve: () => {},
});

/** 弹统一风格的文本输入框；确认返回输入串、取消/Esc 返回 null。 */
export function askPrompt(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    Object.assign(store, {
      open: true,
      title: opts.title,
      message: opts.message ?? "",
      placeholder: opts.placeholder ?? "",
      initial: opts.initial ?? "",
      confirmText: opts.confirmText ?? "确认",
      cancelText: opts.cancelText ?? "取消",
      resolve,
    });
  });
}

function finish(value: string | null): void {
  store.open = false;
  store.resolve(value);
}

/** 挂载一次（App 根）。渲染 PromptDialog 并把结果写回 store 的 resolve。 */
export const PromptHost = defineComponent({
  name: "PromptHost",
  render() {
    return h(PromptDialog, {
      open: store.open,
      title: store.title,
      message: store.message,
      placeholder: store.placeholder,
      initial: store.initial,
      confirmText: store.confirmText,
      cancelText: store.cancelText,
      onConfirm: (value: string) => finish(value),
      onCancel: () => finish(null),
    });
  },
});
