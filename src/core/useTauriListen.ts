import { onScopeDispose } from "vue";

/**
 * Tauri 事件监听 composable（统一"异步 listen + 卸载竞态防护"模式）。
 *
 * 为什么需要：`listen()` 是异步 promise，组件可能在它 resolve 之前卸载——若
 * 直接 `un = await listen(...)`，cleanup 里 `un?.()` 是 no-op（un 仍为 null），
 * 等 promise resolve 后监听器被**永久注册**（已卸载组件仍收事件、仍调 handler）。
 * 本 composable 统一处理：resolve 后检测到已卸载 → 立即注销；未注销 → 登记给
 * scope 清理（onScopeDispose）。
 *
 * 与 React 版差异：Vue 的闭包捕获响应式状态永远是当前值，handler 无需经 ref
 * 持有——传内联闭包即可，始终调用最新逻辑，且只按 event 订阅一次。
 *
 * 注意：只能在组件 setup / composable 的 effect scope 内调用（依赖
 * onScopeDispose 清理）；模块级单例监听请直接用 @tauri-apps/api/event 的
 * listen（如 vault.ts 的 notes-changed 监听）。
 */
export function useTauriListen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): void {
  let un: (() => void) | null = null;
  let cancelled = false;
  import("@tauri-apps/api/event")
    .then((m) =>
      m.listen<T>(event, (e) => {
        if (cancelled) return;
        handler(e.payload);
      }),
    )
    .then((fn) => {
      // 竞态兜底：resolve 时已卸载 → 立即注销；否则登记给 scope 清理
      if (cancelled) fn();
      else un = fn;
    })
    .catch(() => {
      /* 非 Tauri 环境（浏览器 mock）无事件总线，忽略 */
    });
  onScopeDispose(() => {
    cancelled = true;
    un?.();
  });
}
