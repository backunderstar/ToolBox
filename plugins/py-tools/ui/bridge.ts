/** 宿主注入的桥 API（每个插件 UI 只声明自己用到的字段；类型不能放 `.vue` 的
 *  `<script setup>` 里导出，故单独建 bridge.ts）。
 *  process 插件的界面与 Python 子进程经同一桥通信：
 *  `api.call` → plugin_call → 宿主路由到 JSON-RPC（stdin/stdout），
 *  `api.on` 订阅插件推送的 Notification 事件（plugin-event）。 */
export interface PluginBridgeApi {
  /** 本插件 id（宿主注入） */
  pluginId: string;
  /** 调用插件命令（默认本插件；targetPluginId 可跨插件调用）
   *  → plugin_call 统一路由（native→FFI / process→JSON-RPC / webview→前端注册表） */
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  /** 订阅插件事件（默认只收本插件；targetPluginId 跨插件订阅）→ plugin-event */
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  /** 宿主上下文快照：当前工作区路径等（随工作区切换更新） */
  context: { vault: string | null } & Record<string, unknown>;
  /** 跨视图导航（宿主 Sidebar 同机制） */
  nav?: { go: (view: string) => void };
  /** 宿主能力（搜索迁回本体后经此调用，含搜索提供者聚合） */
  host?: { search: (query: string) => Promise<unknown[]> };
}
