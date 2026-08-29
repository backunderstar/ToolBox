<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { pluginsReadFile, vaultGet, floatSetLocked } from "../core/api";
import { buildBridgeApi, injectPluginScript, type PluginBridgeApi } from "../core/pluginRuntime";
import { useTauriListen } from "../core/useTauriListen";
import "./float.css";

/**
 * 桌面半透明浮窗（快速工具）—— 插件自带前端加载器：
 * - 独立窗口（transparent + 无边框 + 桌面层不置顶），加载同一前端入口，按窗口 label 分流到这里
 * - **宿主统一外壳**：标题栏（拖拽区 + 位置锁定）+ 底部页签，
 *   插件只渲染内容区（core-example 自带前端，与主窗口 PluginUiView
 *   同一注入机制——同一插件 UI 可同时服务于主窗与浮窗）；锁定时禁用拖拽与调整大小
 * - 插件不可用时显示错误兜底
 */
const TABS = [
  { id: "core-example", label: "示例" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const containerRef = ref<HTMLDivElement | null>(null);
const vaultPath = ref<string | null>(null);
const error = ref<string | null>(null);
const tab = ref<TabId>("core-example");
/* 位置锁定状态（localStorage 持久化；try/catch 兜底浏览器异常环境） */
let initialLocked = false;
try {
  initialLocked = localStorage.getItem("toolbox.float.locked") === "1";
} catch {
  /* 忽略 */
}
const locked = ref(initialLocked);

/* 浮窗模式：body 背景透明（窗口自身 transparent，露出圆角外区域） */
onMounted(() => {
  document.body.classList.add("float-mode");
});
onBeforeUnmount(() => {
  document.body.classList.remove("float-mode");
});

/* 读取当前工作区（无则插件内提示；切换后重建桥重新挂载） */
onMounted(() => {
  vaultGet()
    .then((s) => {
      vaultPath.value = s.path;
    })
    .catch(() => {
      vaultPath.value = null;
    });
});

/* 主窗口切换工作区后 Rust 广播 vault-changed：浮窗据此重读，避免继续写旧工作区。
   异步 listen 与卸载竞态由 useTauriListen 统一处理。 */
useTauriListen("vault-changed", () => {
  vaultGet()
    .then((s) => {
      vaultPath.value = s.path;
    })
    .catch(() => {
      vaultPath.value = null;
    });
});

interface UiRegistry {
  mount: (el: HTMLElement, api: PluginBridgeApi) => void;
  unmount?: () => void;
}

/* 加载当前页签插件自带前端并挂载（统一桥） */
let disposeCurrent: (() => void) | null = null;

async function load(): Promise<void> {
  disposeCurrent?.();
  disposeCurrent = null;
  let disposed = false;
  const currentTab = tab.value;
  const w = window as unknown as Record<string, unknown>;
  let scriptUn: (() => void) | null = null;
  let styleEl: HTMLStyleElement | null = null;

  // 统一桥（call → plugin_call / on → plugin-event）
  const api: PluginBridgeApi = buildBridgeApi(currentTab, () => vaultPath.value);

  disposeCurrent = () => {
    disposed = true;
    (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.[currentTab]?.unmount?.();
    scriptUn?.();
    styleEl?.remove();
  };

  try {
    // 1. 样式注入（Vite 提取的 style.css；无则跳过）
    try {
      const css = await pluginsReadFile(currentTab, "ui/style.css");
      if (disposed) return;
      styleEl = document.createElement("style");
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    } catch {
      /* 无样式文件 */
    }
    // 2. 注入入口 JS（Blob URL script，顶层副作用注册 UI）
    const code = await pluginsReadFile(currentTab, "ui/index.js");
    if (disposed) return;
    scriptUn = await injectPluginScript(code);
    if (disposed) return;
    // 3. 取注册表并挂载
    const reg = (w.__TB_PLUGIN_UI__ as Record<string, UiRegistry> | undefined)?.[currentTab];
    if (!reg?.mount || !containerRef.value) {
      throw new Error("插件未注册界面（ui/index.js 缺少 __TB_PLUGIN_UI__ 注册）");
    }
    reg.mount(containerRef.value, api);
    error.value = null;
  } catch (e) {
    error.value = String(e);
  }
}

/* 页签/工作区变化时重建桥并重新挂载 */
watch([tab, vaultPath], () => void load(), { immediate: true });

onBeforeUnmount(() => disposeCurrent?.());

function toggleLock(): void {
  const next = !locked.value;
  locked.value = next;
  try {
    localStorage.setItem("toolbox.float.locked", next ? "1" : "0");
  } catch {
    /* 忽略 */
  }
  floatSetLocked(next).catch(() => undefined);
}
</script>

<template>
  <div class="float-window">
    <!-- 宿主标题栏：拖拽区 + 快捷键提示 + 位置锁定（所有页签共用）；
         锁定后禁用拖拽：不给标题栏加 data-tauri-drag-region（锁按钮除外，需可点击） -->
    <div class="float-titlebar" :data-tauri-drag-region="locked ? undefined : true">
      <span class="float-title" :data-tauri-drag-region="locked ? undefined : true">
        {{ TABS.find((t) => t.id === tab)?.label }}
      </span>
      <span class="float-hotkey" title="全局快捷键 Alt+Q：显示/隐藏浮窗">Alt+Q</span>
      <button
        class="float-lock"
        :class="{ on: locked }"
        :title="locked ? '已锁定位置 —— 点击解锁（可拖拽/调整大小）' : '锁定位置（防误拖）'"
        :aria-label="locked ? '解锁位置' : '锁定位置'"
        :aria-pressed="locked"
        @click="toggleLock"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      </button>
    </div>

    <!-- 插件内容区 -->
    <div v-if="error" class="float-empty">
      插件界面加载失败
      <div style="font-size: 11px; margin-top: 4px">{{ error }}</div>
    </div>
    <div
      v-else
      ref="containerRef"
      style="display: flex; flex-direction: column; flex: 1; min-height: 0"
    />

    <!-- 底部页签：待办 / 清单 -->
    <div class="float-tabs">
      <button
        v-for="t in TABS"
        :key="t.id"
        class="float-tab"
        :class="{ on: tab === t.id }"
        @click="tab = t.id"
        :aria-pressed="tab === t.id"
      >
        {{ t.label }}
      </button>
    </div>
  </div>
</template>
