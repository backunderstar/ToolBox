<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { pluginsReadFile, searchAll } from "../core/api";
import { useVault } from "../core/vault";
import { useNav } from "../core/navigation";
import { buildBridgeApi, injectPluginScript, type PluginBridgeApi } from "../core/pluginRuntime";

interface UiRegistry {
  mount: (el: HTMLElement, api: PluginBridgeApi) => void;
  unmount?: () => void;
}

/**
 * 插件自带前端容器（组件模式）：
 * 读插件目录 ui/index.js（自包含 IIFE，React 已打进产物）→ Blob URL <script> 注入
 * （公共运行时 injectPluginScript，与 webview 插件同机制）→ 插件注册到
 * window.__TB_PLUGIN_UI__[pluginId] → 本组件把统一 api 桥注入并挂载到容器。
 *
 * 迁移说明：React 版用 effect + cleanup，Vue 版用 watch(pluginId + vault.path)
 * 先清理旧挂载再加载新的；context.activePath/activeContent 惰性读取直接用
 * reactive 的 vault.state（始终是最新值，无需 ref 快照）。
 */
const props = defineProps<{ pluginId: string }>();

const vault = useVault();
const nav = useNav();
const containerRef = ref<HTMLDivElement | null>(null);
const error = ref<string | null>(null);

let disposeCurrent: (() => void) | null = null;

async function load(): Promise<void> {
  // 先清理旧挂载（页签/工作区变化时重建桥并重新挂载）
  disposeCurrent?.();
  disposeCurrent = null;
  let disposed = false;
  const pluginId = props.pluginId;
  const w = window as unknown as Record<string, unknown>;
  let scriptUn: (() => void) | null = null;
  let styleEl: HTMLStyleElement | null = null;

  // 统一 api 桥（与 webview 插件同构：call → plugin_call / on → plugin-event）。
  // context 扩展惰性读取：getter 直接读响应式 vault.state，始终是最新值
  // （用户切换笔记后插件读到的应是"当前"笔记，而非挂载时快照）。
  const api: PluginBridgeApi = buildBridgeApi(pluginId, () => vault.state.path, {
    nav: {
      go: (view: string) => nav.go(view),
    },
    context: {
      get activePath() {
        return vault.state.activePath;
      },
      get activeContent() {
        return vault.state.content;
      },
    },
    // 宿主能力：搜索迁回本体后插件界面经统一桥调用（含搜索提供者聚合）
    host: {
      search: (query: string) => {
        if (!vault.state.path) return Promise.reject(new Error("工作区未设置"));
        return searchAll(vault.state.path, query);
      },
    },
  });

  disposeCurrent = () => {
    disposed = true;
    (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.[pluginId]?.unmount?.();
    scriptUn?.();
    styleEl?.remove();
  };

  try {
    // 1. 样式注入（Vite 提取的 style.css；无则跳过）
    try {
      const css = await pluginsReadFile(pluginId, "ui/style.css");
      if (disposed) return;
      styleEl = document.createElement("style");
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    } catch {
      /* 无样式文件 */
    }
    // 2. 注入入口 JS（Blob URL script，顶层副作用注册 UI）
    const code = await pluginsReadFile(pluginId, "ui/index.js");
    if (disposed) return;
    scriptUn = await injectPluginScript(code);
    if (disposed) return;
    // 3. 取注册表并挂载
    const reg = (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.[pluginId];
    if (!reg?.mount || !containerRef.value) {
      throw new Error("插件未注册界面（ui/index.js 缺少 __TB_PLUGIN_UI__ 注册）");
    }
    reg.mount(containerRef.value, api);
    error.value = null;
  } catch (e) {
    error.value = String(e);
  }
}

watch(
  () => [props.pluginId, vault.state.path] as const,
  () => void load(),
  { immediate: true },
);

onBeforeUnmount(() => disposeCurrent?.());
</script>

<template>
  <div class="plugin-ui-view">
    <div ref="containerRef" class="plugin-ui-container" />
    <div v-if="error" class="empty-state plugin-error">{{ error }}</div>
  </div>
</template>
