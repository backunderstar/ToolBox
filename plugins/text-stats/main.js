/**
 * 文本统计插件（webview JS 插件示例）
 *
 * 通过插件 API 注册一个命令 `analyze`：
 *   api.app.registerCommand({ id, name, run })
 * 运行入口会收到 `api` 对象（含 app/fs/events/log）。
 */

api.app.registerCommand({
  id: "analyze",
  name: "统计文本",
  run: async (args) => {
    const text = typeof args?.text === "string" ? args.text : "";
    const trimmed = text.trim();
    return {
      chars: [...text].length,
      words: trimmed ? trimmed.split(/\s+/).length : 0,
      lines: text.length === 0 ? 0 : text.split("\n").length,
      paragraphs: trimmed ? trimmed.split(/\n\s*\n/).length : 0,
      empty: text.length === 0,
    };
  },
});
