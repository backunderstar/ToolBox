/** 宿主注入的桥 API（每个插件 UI 只声明自己用到的字段） */
export interface PluginBridgeApi {
  pluginId: string;
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  context: { vault: string | null } & Record<string, unknown>;
  nav?: {
    go: (view: string) => void;
    openNote: (rel: string) => void;
    openChecklist: (id: string) => void;
  };
  /** 宿主能力（搜索迁回本体后经此调用，含搜索提供者聚合） */
  host?: { search: (query: string) => Promise<unknown[]> };
}
