<script setup lang="ts">
import { computed } from "vue";
import { isCoreConnected, type PingInfo } from "../core/ipc";
import { RUNTIME_LABEL, type PluginInfo } from "../core/api";

/**
 * 概览页（应用外壳）：环境信息卡 + 已安装插件网格 + 快捷入口。
 */
const props = defineProps<{
  ping: PingInfo | null;
  themeName: string;
  plugins: PluginInfo[];
  onOpenExample: () => void;
  onOpenPlugins: () => void;
}>();

const ok = computed(() => isCoreConnected(props.ping));
</script>

<template>
  <div class="welcome">
    <section class="hero fade-in">
      <div class="hero-overline">ToolBox · Personal Workbench</div>
      <h1>个人工具箱</h1>
      <p>
        你的笔记、文件与工具，围绕一个普通文件夹展开。
        数据始终是你的——随时可迁移、可备份、可发布。
      </p>
      <div class="hero-actions">
        <button class="btn-primary" @click="onOpenExample">打开示例插件</button>
      </div>
    </section>

    <section class="env-card fade-in" style="animation-delay: 80ms">
      <div class="env-item">
        <span class="env-key">IPC 状态</span>
        <span class="env-value" :class="ok ? 'ok' : 'warn'">
          {{ ping ? ping.message : "连接中…" }}
        </span>
      </div>
      <div class="env-item">
        <span class="env-key">核心版本</span>
        <span class="env-value">v{{ ping?.coreVersion ?? "…" }}</span>
      </div>
      <div class="env-item">
        <span class="env-key">平台</span>
        <span class="env-value">{{ ping?.os ?? "…" }}</span>
      </div>
      <div class="env-item">
        <span class="env-key">主题</span>
        <span class="env-value">{{ themeName }}</span>
      </div>
    </section>

    <section>
      <h2 class="section-title">已安装插件</h2>
      <p v-if="plugins.length === 0" class="module-empty">暂无插件</p>
      <div v-else class="module-grid">
        <article
          v-for="(p, i) in plugins"
          :key="p.id"
          class="module-card module-card-clickable fade-in"
          :style="{
            '--i': i,
            animationDelay: `${120 + Math.min(i, 8) * 50}ms`,
          }"
          @click="onOpenPlugins"
          title="点击进入插件页"
        >
          <div class="module-name">
            {{ p.name }}
            <span v-if="p.builtin" class="tag tag-core">核心</span>
            <span v-if="p.system" class="tag tag-muted">系统</span>
            <span v-if="p.provider" class="tag tag-muted">搜索提供者</span>
          </div>
          <p class="module-desc">{{ p.description }}</p>
          <div class="module-meta">
            <span class="tag tag-muted">{{ RUNTIME_LABEL[p.runtime] ?? p.runtime }}</span>
            <span class="tag tag-muted">v{{ p.version }}</span>
            <span class="tag" :class="p.enabled ? 'tag-done' : 'tag-plan'">
              {{ p.enabled ? "已启用" : "已禁用" }}
            </span>
          </div>
        </article>
      </div>
    </section>

    <div class="hint fade-in">
      <kbd>Ctrl</kbd>+<kbd>K</kbd>
      <span>任意视图下聚焦顶栏全局搜索，检索文件名、内容与清单待办</span>
    </div>
  </div>
</template>
