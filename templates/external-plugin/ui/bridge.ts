/** 宿主注入的桥 API（只声明本模板用到的字段；完整字段见 ToolBox 插件开发指南 §2.3
 *  与 src/core/pluginRuntime.ts）。类型不能放 .vue 的 <script setup> 里导出，
 *  故单独建 bridge.ts。 */
export interface PluginBridgeApi {
  /** 本插件 id（宿主注入） */
  pluginId: string;
  /** 调用插件命令（默认本插件；targetPluginId 可跨插件调用）
   *  → 宿主统一路由（native→FFI / process→JSON-RPC / webview→前端注册表） */
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  /** 订阅插件事件（默认只收本插件）→ plugin-event */
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  /** 宿主上下文快照：当前工作区路径等 */
  context: { vault: string | null } & Record<string, unknown>;
  /** 跨视图导航（宿主 Sidebar 同机制） */
  nav?: { go: (view: string) => void };
  /** 宿主能力（全文搜索等，搜索提供者插件用） */
  host?: { search: (query: string) => Promise<unknown[]> };
}
