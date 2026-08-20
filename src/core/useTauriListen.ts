import { useEffect, useRef } from "react";

/**
 * Tauri 事件监听 hook（统一"异步 listen + 卸载竞态防护"模式）。
 *
 * 为什么需要：`listen()` 是异步 promise，组件可能在它 resolve 之前卸载——若
 * 直接 `un = await listen(...)`，cleanup 里 `un?.()` 是 no-op（un 仍为 null），
 * 等 promise resolve 后监听器被**永久注册**（已卸载组件仍收事件、仍调 handler）。
 * 本 hook 统一处理：resolve 后检测到已卸载 → 立即注销；未卸载 → 登记给 cleanup。
 *
 * handler 经 ref 持有：调用方传内联闭包也不会反复重订阅（只按 event 订阅一次），
 * 且始终调用最新闭包（等价于把相关状态加入依赖数组的效果）。
 */
export function useTauriListen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let un: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then((m) =>
        m.listen<T>(event, (e) => {
          if (cancelled) return;
          handlerRef.current(e.payload);
        }),
      )
      .then((fn) => {
        // 竞态兜底：resolve 时已卸载 → 立即注销；否则登记给 cleanup
        if (cancelled) fn();
        else un = fn;
      })
      .catch(() => {
        /* 非 Tauri 环境（浏览器 mock）无事件总线，忽略 */
      });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [event]);
}
