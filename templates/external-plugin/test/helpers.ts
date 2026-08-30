import { vi } from "vitest";
import type { PluginBridgeApi } from "../ui/bridge";

/** 构造 mock api：call / on / host.search 全打桩；返回 emit 供测试手动触发事件。 */
export function mockApi() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const api: PluginBridgeApi = {
    pluginId: "my-plugin",
    call: vi.fn(async (command: string, args?: unknown) => {
      if (command === "hello") {
        const name = (args as { name?: string })?.name;
        return { message: `你好${name ? "，" + name : ""}，来自 Python 插件！` };
      }
      if (command === "eventDemo") return { text: "已发送 3 个进度事件" };
      if (command === "fileList") return { count: 2, files: ["notes/a.md", "tasks/b.md"] };
      if (command === "notifyDemo") return { ok: true };
      throw new Error(`未知命令: ${command}`);
    }),
    on: vi.fn((event: string, cb: (data: unknown) => void) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
      };
    }),
    context: { vault: "D:\\mock\\vault" },
    host: {
      search: vi.fn(async () => [
        { filename: "a.md", source: "py-tools", snippet: "命中片段" },
      ]),
    },
  };
  return {
    api,
    emit(event: string, data: unknown): void {
      listeners.get(event)?.forEach((cb) => cb(data));
    },
  };
}
