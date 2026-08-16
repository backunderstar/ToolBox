// cdp-ai-ui.mjs — core-ai 插件自带前端 E2E：挂载/对话错误路径/预设按钮
import { findMainPage, connect, sleep , helpers } from "./cdp-lib.mjs";
const PORT = process.argv[2] ?? "9226";
const page = await findMainPage(PORT);
if (!page) { console.error("no main page"); process.exit(1); }
const { ev } = await connect(page);
const { waitFor, clickText, log } = helpers(ev);

await sleep(800);

// ---- 1. AI 视图渲染插件自带前端 ----
await waitFor(`document.querySelectorAll('.nav-item').length > 0`, "导航项出现");
await clickText(".nav-item", "AI 整理");
await waitFor(`!!document.querySelector('.plugin-ui-view .ai-view')`, "插件自带界面挂载");
const hostView = await ev(`!!document.querySelector('.ai-view:not(.plugin-ui-view .ai-view)')`);
if (hostView) throw new Error("宿主 AIChatView 与插件界面并存");
log("PASS AI 页渲染插件自带前端（core-ai ui/index.js）");

// ---- 2. 预设按钮（自适应：宿主有当前笔记时可用，否则禁用）----
const presetsEnabled = await ev(`[...document.querySelectorAll('.plugin-ui-view .ai-presets button')].some(b => !b.disabled)`);
if (presetsEnabled) {
  // 宿主 vault 有当前笔记（如经笔记视图同步）→ 点"总结当前笔记"走预设流程（无 Key → 错误引导）
  await clickText(".plugin-ui-view .ai-presets button", "总结当前笔记");
  await waitFor(`[...document.querySelectorAll('.plugin-ui-view .ai-msg.ai-msg-user')].some(m => m.textContent.includes('请总结这篇笔记'))`, "预设动作用户消息出现");
  await waitFor(`document.querySelectorAll('.plugin-ui-view .ai-msg.ai-msg-assistant.err').length >= 1`, "预设动作错误回复（无 API Key）");
  log("PASS 预设动作可用（context 快照有当前笔记）→ 点击走对话流程");
} else {
  const hint = await ev(`document.querySelector('.plugin-ui-view .ai-empty .ai-hint')?.textContent`);
  if (!hint?.includes("打开一篇笔记")) throw new Error(`无当前笔记时应有提示: ${hint}`);
  log("PASS 预设按钮随 context 快照禁用（未打开笔记）+ 提示文案正确");
}

// ---- 3. 发送消息 → 桥调用 → 无 Key 错误提示 ----
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .ai-chat-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '你好');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await clickText(".plugin-ui-view .ai-input-row button", "发送");
await waitFor(`!!document.querySelector('.plugin-ui-view .ai-msg.ai-msg-assistant.err')`, "AI 错误消息出现（未配置 API Key）");
const errText = await ev(`document.querySelector('.plugin-ui-view .ai-msg.ai-msg-assistant.err .ai-msg-content')?.textContent`);
if (!errText?.includes("未配置 API Key")) throw new Error(`错误文案不符: ${errText}`);
log("PASS 对话经桥调用 ai.chatStream（无 Key → 错误引导文案）");

// ---- 4. 笔记问答（RAG 检索路径，同样以无 Key 错误收尾，验证跨插件检索未阻塞）----
await ev(`(() => {
  const el = document.querySelector('.plugin-ui-view .ai-chat-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, 'E2E');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await clickText(".plugin-ui-view .ai-input-row button", "笔记问答");
await waitFor(`[...document.querySelectorAll('.plugin-ui-view .ai-msg.ai-msg-user')].some(m => m.textContent.includes('基于笔记检索'))`, "RAG 用户消息出现");
await waitFor(`document.querySelectorAll('.plugin-ui-view .ai-msg.ai-msg-assistant.err').length >= 2`, "RAG 回复（错误路径）出现");
log("PASS 笔记问答走宿主内嵌搜索 → 流式对话错误路径（无 Key）");

log("\n========== AI_UI_E2E_PASS ==========");
process.exit(0);
