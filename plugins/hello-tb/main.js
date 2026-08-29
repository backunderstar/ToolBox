// hello-tb：最小 webview 插件（命令注册式）——照插件开发指南 §1「五分钟跑通」。
// 宿主注入全局 `api` 对象：registerCommand 注册命令 → 插件页命令试用台可调。
api.app.registerCommand({
  id: "sayHello",
  name: "打招呼",
  run: async (args) => ({ text: `你好，${args?.name || "世界"}！` }),
});
