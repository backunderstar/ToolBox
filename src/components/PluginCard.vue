<script setup lang="ts">
import { computed } from "vue";
import { RUNTIME_LABEL, type PluginInfo } from "../core/api";
import Icon from "./Icon.vue";
import CommandTry from "./CommandTry.vue";
import type { ViewId } from "../core/navigation";

/** 插件卡片（插件页核心/外部插件组共用）：标题/徽标/操作/描述/错误/命令试用台。 */
const props = defineProps<{
  plugin: PluginInfo;
  busy: boolean;
  runtimeError: string | undefined;
  commands: { id: string; name: string }[];
  invoke: (pluginId: string, command: string, args: unknown) => Promise<unknown>;
  onToggle: (id: string, enabled: boolean) => void;
  onReload: (id: string) => void;
  onUninstall: (id: string) => void;
  onOpen: (view: ViewId) => void;
  /** 安装依赖（process 插件且有 requirements.txt 时显示按钮） */
  onInstallDeps: (id: string) => void;
  /** 依赖安装进行中（按钮显示"安装中…"并禁用） */
  depsBusy: boolean;
}>();

const STATUS_TEXT: Record<string, string> = {
  ready: "就绪",
  stopped: "已停止",
  error: "错误",
};

const p = computed(() => props.plugin);
const err = computed(() => props.plugin.error ?? props.runtimeError);
// webview 入口求值失败时，以"错误"状态展示（Rust 侧不知道前端加载结果）
const status = computed(() => (props.runtimeError ? "error" : props.plugin.status));
</script>

<template>
  <section class="plugin-card">
    <div class="plugin-head">
      <div class="plugin-title">
        <h2>{{ p.name }}</h2>
        <span class="badge badge-version">v{{ p.version }}</span>
        <span class="badge badge-runtime">{{ RUNTIME_LABEL[p.runtime] ?? p.runtime }}</span>
        <span v-if="p.builtin" class="badge badge-builtin">核心</span>
        <span
          v-if="p.system"
          class="badge badge-provider"
          title="数据安全/横切能力，不可禁用"
        >
          系统
        </span>
        <span
          v-if="p.provider"
          class="badge badge-provider"
          title="实现 search.provide，启用后进入全局搜索"
        >
          搜索提供者
        </span>
        <span
          v-if="p.theme"
          class="badge badge-theme"
          title="皮肤插件：启用后作为主题出现在设置页 → 主题选择器"
        >
          主题
        </span>
        <span class="badge badge-status" :class="`badge-status-${status}`">
          {{ STATUS_TEXT[status] ?? status }}
        </span>
      </div>
      <div class="plugin-actions">
        <!-- 打开界面：插件声明了自带前端（ui）且有导航入口时可用 -->
        <button
          v-if="p.ui && p.nav.length > 0"
          class="btn btn-sm"
          :title="`打开「${p.name}」的界面`"
          @click="onOpen(p.nav[0].id as ViewId)"
        >
          打开
        </button>
        <button
          v-if="!p.system"
          class="btn btn-sm"
          @click="onToggle(p.id, !p.enabled)"
          :disabled="busy || p.status === 'error'"
        >
          {{ p.enabled ? "禁用" : "启用" }}
        </button>
        <button
          v-if="p.runtime === 'process' && p.hasDeps"
          class="btn btn-sm"
          :title="'用捆绑 Python 的 pip 安装 requirements.txt 到 vendor/（需有网）'"
          @click="onInstallDeps(p.id)"
          :disabled="busy || depsBusy"
        >
          {{ depsBusy ? "安装中…" : "安装依赖" }}
        </button>
        <button class="btn btn-sm" @click="onReload(p.id)" :disabled="busy || !p.enabled">
          重新加载
        </button>
        <button
          v-if="!p.system"
          class="btn btn-sm danger"
          :title="
            p.builtin
              ? '卸载：彻底删除 DLL 与目录（随应用分发的资源可重新安装）'
              : '卸载：删除插件目录（进回收站）'
          "
          :aria-label="`卸载插件 ${p.name}`"
          @click="onUninstall(p.id)"
          :disabled="busy"
        >
          <Icon name="trash" :size="12" />
          卸载
        </button>
      </div>
    </div>

    <p class="plugin-desc">{{ p.description || "（无描述）" }}</p>
    <code class="plugin-id">{{ p.id }}</code>

    <p v-if="err" class="plugin-error" :title="err">{{ err }}</p>

    <div v-if="commands.length > 0" class="plugin-commands">
      <span class="plugin-commands-label">命令</span>
      <CommandTry
        v-for="c in commands"
        :key="c.id"
        :plugin-id="p.id"
        :command="c.id"
        :name="c.name"
        :invoke="invoke"
      />
    </div>
  </section>
</template>
