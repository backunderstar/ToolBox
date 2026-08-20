/** 宿主注入的桥 API（每个插件 UI 只声明自己用到的字段） */
export interface PluginBridgeApi {
  pluginId: string;
  /** 调用插件命令：默认调本插件；指定 targetPluginId 可跨插件调用 */
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  /** 订阅 plugin-event（默认本插件；可指定 targetPluginId），返回取消函数 */
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  /** 宿主注入的上下文：vault 路径 + 扩展字段（activePath / activeContent） */
  context: { vault: string | null } & Record<string, unknown>;
  /** 宿主导航（主窗口可用；浮窗等独立窗口为 undefined） */
  nav?: { go: (view: string) => void };
  /** 宿主能力（搜索迁回本体后经此调用，含搜索提供者聚合） */
  host?: { search: (query: string) => Promise<SearchHit[]> };
}

export interface SearchHit {
  path: string;
  filename: string;
  snippet: string;
}
