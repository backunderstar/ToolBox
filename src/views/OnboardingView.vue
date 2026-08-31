<script setup lang="ts">
import { computed } from "vue";
import { useVault } from "../core/vault";
import { listThemes, swatchOf, SYSTEM_THEME_ID } from "../themes/themes";
import Icon from "../components/Icon.vue";

/**
 * 首启引导页（2026-09 用户需求）：安装后首次打开直接进基础配置——
 * ① 数据根目录（所有数据的家，必配）② 主题（默认已选，可换）。
 * 配置完成（root 就绪）后自动进入主界面。
 */
const props = defineProps<{
  themeId: string;
  onSetThemeId: (id: string) => void;
  onDone: () => void;
}>();

const vault = useVault();
const themes = computed(() => listThemes());
const rootSet = computed(() => !!vault.state.root);
</script>

<template>
  <div class="onboarding">
    <div class="onboarding-card">
      <div class="onboarding-brand">
        <div class="onboarding-logo">TB</div>
        <h1 class="onboarding-title">欢迎使用 ToolBox</h1>
        <p class="onboarding-sub">先配置好你的「数据之家」——所有项目、文件与数据都围绕一个文件夹展开。</p>
      </div>

      <!-- 步骤 1：数据根目录 -->
      <section class="onboarding-step">
        <h2 class="onboarding-step-title"><span class="step-no">1</span>数据根目录</h2>
        <p class="onboarding-hint">
          选择一个文件夹作为所有数据的根（如 D:\ToolBoxData）。根下自动创建
          <code>Project/</code> 存放工作区——每个项目一个文件夹（如
          <code>Project/MG5</code> 即工作区 MG5），日常选定工作区后，文件处理大多经插件进行。
          插件与系统配置仍存放在系统目录，与数据分离。
        </p>
        <div class="onboarding-body">
          <code v-if="vault.state.root" class="onboarding-path" :title="vault.state.root">
            {{ vault.state.root }}
          </code>
          <span v-else class="onboarding-noroot">尚未选择数据根目录</span>
          <button class="btn" @click="vault.pickWorkspaceRoot">
            <Icon name="folder" :size="13" />
            {{ vault.state.root ? "更换数据根目录…" : "选择数据根目录…" }}
          </button>
        </div>
      </section>

      <!-- 步骤 2：主题 -->
      <section class="onboarding-step">
        <h2 class="onboarding-step-title"><span class="step-no">2</span>主题</h2>
        <div class="theme-grid">
          <div
            class="theme-card"
            :class="{ active: themeId === SYSTEM_THEME_ID }"
            role="button"
            tabindex="0"
            :aria-current="themeId === SYSTEM_THEME_ID ? 'true' : undefined"
            @click="onSetThemeId(SYSTEM_THEME_ID)"
            title="跟随系统亮/暗模式自动切换"
          >
            <div class="theme-swatches">
              <span class="theme-swatch" style="background: #f6f5f2" />
              <span class="theme-swatch" style="background: #1b1a17" />
              <span
                class="theme-swatch"
                style="background: linear-gradient(90deg, #f6f5f2 50%, #1b1a17 50%)"
              />
            </div>
            <div class="theme-card-name">跟随系统</div>
            <div class="theme-card-desc">随系统亮/暗模式自动切换</div>
          </div>
          <div
            v-for="t in themes"
            :key="t.id"
            class="theme-card"
            :class="{ active: themeId === t.id }"
            role="button"
            tabindex="0"
            :aria-current="themeId === t.id ? 'true' : undefined"
            @click="onSetThemeId(t.id)"
            :title="t.description"
          >
            <div class="theme-swatches">
              <span
                v-for="(c, i) in swatchOf(t)"
                :key="i"
                class="theme-swatch"
                :style="{ background: c }"
              />
            </div>
            <div class="theme-card-name">{{ t.name }}</div>
            <div class="theme-card-desc">{{ t.description }}</div>
          </div>
        </div>
      </section>

      <div class="onboarding-actions">
        <button class="btn-primary" :disabled="!rootSet" @click="onDone">
          {{ rootSet ? "进入 ToolBox" : "请先选择数据根目录" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onboarding {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  overflow: auto;
  padding: var(--space-6);
}
.onboarding-card {
  width: 580px;
  max-width: calc(100vw - 48px);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}
.onboarding-brand {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}
.onboarding-logo {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-lg);
  background: var(--accent);
  color: var(--on-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: var(--text-xl);
  letter-spacing: 0.02em;
  box-shadow: var(--shadow-2);
}
.onboarding-title {
  margin: var(--space-2) 0 0;
  font-size: var(--text-2xl);
  letter-spacing: -0.02em;
}
.onboarding-sub {
  margin: 0;
  color: var(--fg-muted);
  font-size: var(--text-sm);
  max-width: 440px;
}
.onboarding-step {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.onboarding-step-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-md);
  letter-spacing: -0.01em;
}
.step-no {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-xs);
  font-weight: 600;
}
.onboarding-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--fg-muted);
  line-height: 1.6;
}
.onboarding-hint code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
  color: var(--fg);
}
.onboarding-body {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.onboarding-path {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--accent-strong);
  background: var(--bg-soft);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 6px 10px;
  word-break: break-all;
}
.onboarding-noroot {
  font-size: var(--text-sm);
  color: var(--fg-faint);
}
.onboarding-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
