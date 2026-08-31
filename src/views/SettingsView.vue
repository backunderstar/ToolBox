<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { isCoreConnected, type PingInfo } from "../core/ipc";
import type { NavConfig, NavItemDef } from "../core/navPrefs";
import { useVault } from "../core/vault";
import { openInExplorer, configExport, configImport, appSettingsGet, appSettingsSet, traySetEnabled } from "../core/api";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  listThemes,
  findTheme,
  swatchOf,
  deleteCustomTheme,
  resolveThemeId,
  SYSTEM_THEME_ID,
  type ThemeDef,
} from "../themes/themes";
import ThemeEditor from "../components/ThemeEditor.vue";
import BackupSettings from "../components/BackupSettings.vue";
import NavSettings from "../components/NavSettings.vue";
import LogSettings from "../components/LogSettings.vue";
import ThemeIoPanel from "../components/ThemeIoPanel.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import Icon from "../components/Icon.vue";
import PluginUiView from "../components/PluginUiView.vue";
import { usePlugins } from "../core/plugins";
import { APP_TAG } from "../core/version";
import { onRowKeyDown } from "../core/keyboard";

/**
 * 设置页：工作区 / 主题（选择器 + 新建/删除/导出导入 + 编辑器）/
 * 导航栏全配置（NavSettings）/ 备份（BackupSettings）/
 * 关于与自动更新。
 * 主题列表来自 themes.ts（内置 + 皮肤插件投影 + localStorage 自定义）。
 */
import { check as checkUpdate } from "@tauri-apps/plugin-updater";

const props = defineProps<{
  themeId: string;
  onSetThemeId: (id: string) => void;
  ping: PingInfo | null;
  /** 归一化后的导航配置（分组/顺序/元数据） */
  navConfig: NavConfig;
  /** 全部导航项定义（静态 + 插件声明） */
  defs: NavItemDef[];
  /** 导航配置变更（保存用户编辑结果） */
  onNavChange: (cfg: NavConfig) => void;
}>();

/** 前端 localStorage 配置段（键集合；导入/导出共用）。模块级常量：避免每次渲染重建 */
const FRONTEND_KEYS = ["toolbox.theme", "toolbox.custom-themes", "toolbox.nav", "toolbox.layout"];

const vault = useVault();
const pluginsCtx = usePlugins();
/* 当前工作区名（显示在下拉/路径截断；多工作区模式下即根目录下子目录名） */
const vaultName = computed(() =>
  vault.state.path ? (vault.state.path.split(/[\\/]/).pop() ?? vault.state.path) : null,
);
/* 设置页工作区下拉切换（多工作区模式） */
function onSwitchWorkspace(e: Event): void {
  const name = (e.target as HTMLSelectElement).value;
  if (name) void vault.switchWorkspace(name);
}
/* 新建工作区（数据根/Project/ 下创建并切换） */
async function createWorkspace(): Promise<void> {
  const name = window.prompt("新建工作区名称（将在 数据根/Project/ 下创建）：");
  if (!name || !name.trim()) return;
  await vault.createWorkspace(name.trim());
}
/* 启用的插件中声明了设置面板（manifest settings.entry）的列表 */
const settingsPlugins = computed(() =>
  pluginsCtx.state.plugins.filter((p) => p.enabled && p.settings),
);
/* 关闭主窗口的行为："tray" 最小化到托盘（默认）/ "quit" 退出应用（app.json closeBehavior） */
const closeBehavior = ref<"tray" | "quit">("tray");
/* 托盘图标开关（app.json trayEnabled）与关闭前询问开关（app.json closeAsk） */
const trayEnabled = ref(true);
const closeAsk = ref(true);
onMounted(() => {
  appSettingsGet()
    .then((s) => {
      if (s.closeBehavior === "quit") closeBehavior.value = "quit";
      if (s.trayEnabled === false) trayEnabled.value = false;
      if (s.closeAsk === false) closeAsk.value = false;
    })
    .catch(() => undefined);
});
function persistCloseBehavior(): void {
  void appSettingsSet("closeBehavior", closeBehavior.value).catch(() => undefined);
}
async function persistTrayEnabled(v: boolean): Promise<void> {
  try {
    await traySetEnabled(v); // Rust 侧写 app.json + 创建/移除托盘
    trayEnabled.value = v;
  } catch (e) {
    trayEnabled.value = !v; // 失败回滚
    void appSettingsSet("trayEnabled", !v).catch(() => undefined);
  }
}
function persistCloseAsk(v: boolean): void {
  closeAsk.value = v;
  void appSettingsSet("closeAsk", v).catch(() => undefined);
}
/* 插件设置手风琴：当前展开的插件 id（null = 全收起；同时只展开一个，插件多时页面不臃肿） */
const expandedPluginSettings = ref<string | null>(null);
function togglePluginSettings(id: string): void {
  expandedPluginSettings.value = expandedPluginSettings.value === id ? null : id;
}
const opening = ref(false);
const editing = ref<ThemeDef | null>(null);
const themeIo = ref(false);
const confirmDelTheme = ref<ThemeDef | null>(null);
/* 删除/新建自定义主题后强制重渲染（listThemes 读 localStorage） */
const themeVersion = ref(0);
/* 自动更新状态：idle 未检查 / checking 检查中 / latest 已最新 / installing 下载安装中 /
   done 安装完成待重启 / error 失败 */
const updateStatus = ref<"idle" | "checking" | "latest" | "installing" | "done" | "error">("idle");
const updateVersion = ref("");
const updateErr = ref("");
/* 状态文案（computed 单值渲染；历史 bug：模板里 `{{ cond && "文本" }}` 多行
   并存会让条件为 false 的行渲染出字面 "false"，见 8/31 设置页检查更新区） */
const updateStatusText = computed(() => {
  switch (updateStatus.value) {
    case "checking":
      return "正在检查…";
    case "latest":
      return "已是最新版本";
    case "installing":
      return `发现 v${updateVersion.value}，正在下载安装…`;
    case "done":
      return `v${updateVersion.value} 已安装，请重启应用生效`;
    case "error":
      return "检查失败（未配置发布源或网络异常）";
    default:
      return "从 GitHub Releases 检测新版本";
  }
});
/* 配置迁移：exporting/importing 进行中；msg 操作结果提示 */
const configBusy = ref<"" | "exporting" | "importing">("");
const configMsg = ref("");

/* 配置导入后的延迟刷新定时器：组件卸载时清理（防止卸载后 reload） */
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => {
  if (reloadTimer) clearTimeout(reloadTimer);
});

const collectFrontend = (): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const k of FRONTEND_KEYS) {
    const v = localStorage.getItem(k);
    if (v !== null) o[k] = v;
  }
  return o;
};

async function onExportConfig(): Promise<void> {
  try {
    configBusy.value = "exporting";
    const path = await save({
      defaultPath: "toolbox-config.json",
      filters: [{ name: "ToolBox 配置", extensions: ["json"] }],
    });
    if (typeof path !== "string") return; // 用户取消
    await configExport(path, collectFrontend());
    configMsg.value = "配置已导出（不含 API Key 与笔记数据）";
  } catch (e) {
    configMsg.value = `导出失败: ${String(e)}`;
  } finally {
    configBusy.value = "";
  }
}

async function onImportConfig(): Promise<void> {
  try {
    configBusy.value = "importing";
    const path = await open({
      multiple: false,
      filters: [{ name: "ToolBox 配置", extensions: ["json"] }],
    });
    if (typeof path !== "string") return; // 用户取消
    const cfg = await configImport(path); // 宿主侧（插件状态/备份/AI）已写回
    // 写回前端 localStorage 段
    for (const [k, v] of Object.entries(cfg.frontend ?? {})) {
      if (typeof v === "string" && v) localStorage.setItem(k, v);
    }
    configMsg.value = "配置已导入，正在刷新界面…";
    // 主题/导航是初始 state，刷新后从 localStorage 重读；
    // 插件启停也随插件 store 重新拉取生效
    reloadTimer = setTimeout(() => window.location.reload(), 900);
  } catch (e) {
    configMsg.value = `导入失败: ${String(e)}`;
  } finally {
    configBusy.value = "";
  }
}

async function onCheckUpdate(): Promise<void> {
  try {
    updateStatus.value = "checking";
    const update = await checkUpdate();
    if (!update) {
      updateStatus.value = "latest";
      return;
    }
    updateVersion.value = update.version;
    updateStatus.value = "installing";
    await update.downloadAndInstall();
    updateStatus.value = "done";
  } catch (e) {
    updateStatus.value = "error";
    updateErr.value = String(e);
  }
}

const themes = computed(() => {
  void themeVersion.value; // 删除/新建自定义主题后重算
  return listThemes();
});
// 跟随系统时 findTheme 直接查不到——解析到当前系统 base 的实际主题
// （ThemeEditor "基于当前主题新建" 的起点、描述文案等都用它）
const current = computed(() => findTheme(resolveThemeId(props.themeId)));

async function openFolder(): Promise<void> {
  if (!vault.state.path) return;
  opening.value = true;
  try {
    await openInExplorer(vault.state.path);
  } catch (e) {
    console.error("[settings] 打开工作区失败", e);
  } finally {
    opening.value = false;
  }
}

const ok = computed(() => isCoreConnected(props.ping));

function newTheme(): void {
  const base = current.value?.base ?? "light";
  editing.value = {
    id: `custom-${Date.now().toString(36)}`,
    name: "新主题",
    base,
    description: "自定义主题",
    // 复制当前主题的令牌作起点（内置/自定义/插件主题均可）：
    // 让"基于 XX 新建"真正以 XX 为底，而不是从默认色板白手起家
    tokens: { ...current.value?.tokens },
    custom: true,
  };
}

function removeCustom(id: string): void {
  deleteCustomTheme(id);
  if (props.themeId === id) props.onSetThemeId("default-light");
  editing.value = null;
  confirmDelTheme.value = null;
  themeVersion.value += 1;
}
</script>

<template>
  <div class="settings-view">
    <header class="view-header">
      <div>
        <h1>设置</h1>
        <p class="view-sub">工作区、主题与关于信息</p>
      </div>
    </header>

    <div class="settings-sections">
      <!-- ---- 工作区（数据根模型：根/Project/* = 工作区） ---- -->
      <section class="settings-card">
        <h2 class="settings-title">工作区</h2>
        <div class="settings-row">
          <span class="settings-label">数据根目录</span>
          <code v-if="vault.state.root" class="settings-path" :title="vault.state.root">
            {{ vault.state.root }}
          </code>
          <span v-else class="settings-value warn">未配置（重启应用进入引导页）</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">操作</span>
          <div class="settings-actions">
            <button class="btn" @click="vault.pickWorkspaceRoot">
              <Icon name="folder" :size="13" />
              更换数据根目录…
            </button>
            <span class="settings-hint">
              根下自动创建 Project/ 存放工作区（每个项目一个文件夹）；插件与系统配置仍在系统目录
            </span>
          </div>
        </div>
        <template v-if="vault.state.path">
          <div class="settings-row">
            <span class="settings-label">当前工作区</span>
            <code class="settings-path" :title="vault.state.path">{{ vault.state.path }}</code>
          </div>
          <div class="settings-row">
            <span class="settings-label">切换</span>
            <div class="settings-actions">
              <select
                v-if="vault.state.items.length > 0"
                class="settings-select"
                :value="vaultName"
                title="切换当前工作区"
                @change="onSwitchWorkspace"
              >
                <option v-for="w in vault.state.items" :key="w.name" :value="w.name">
                  {{ w.name }}
                </option>
              </select>
              <span v-else class="settings-value">Project/ 下暂无工作区</span>
              <button class="btn" @click="createWorkspace">
                <Icon name="plus" :size="13" />
                新建工作区
              </button>
              <button class="btn" @click="openFolder" :disabled="opening">
                <Icon name="folder" :size="13" />
                {{ opening ? "打开中…" : "在资源管理器中打开" }}
              </button>
            </div>
          </div>
        </template>
        <div v-else class="settings-row">
          <span class="settings-label">工作区</span>
          <div class="settings-actions">
            <button class="btn" @click="vault.pickWorkspaceRoot">选择数据根目录</button>
            <span class="settings-hint">围绕一个文件夹展开的工具箱：数据始终是你的</span>
          </div>
        </div>
      </section>

      <!-- ---- 常规 ---- -->
      <section class="settings-card">
        <h2 class="settings-title">常规</h2>
        <div class="settings-row">
          <span class="settings-label">关闭主窗口</span>
          <div class="settings-choices" role="radiogroup" aria-label="关闭主窗口时">
            <label class="settings-choice" :class="{ on: closeBehavior === 'tray' }">
              <input
                v-model="closeBehavior"
                type="radio"
                value="tray"
                @change="persistCloseBehavior"
              />
              <span class="settings-choice-body">
                <span class="settings-choice-name">最小化到托盘（后台常驻）</span>
                <span class="settings-choice-desc">点关闭按钮时隐藏到系统托盘，托盘「退出 ToolBox」才真正退出</span>
              </span>
            </label>
            <label class="settings-choice" :class="{ on: closeBehavior === 'quit' }">
              <input
                v-model="closeBehavior"
                type="radio"
                value="quit"
                @change="persistCloseBehavior"
              />
              <span class="settings-choice-body">
                <span class="settings-choice-name">退出应用</span>
                <span class="settings-choice-desc">点关闭按钮时结束全部窗口与进程，不再驻留托盘</span>
              </span>
            </label>
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-label">托盘图标</span>
          <label class="settings-toggle">
            <input
              type="checkbox"
              :checked="trayEnabled"
              @change="persistTrayEnabled(($event.target as HTMLInputElement).checked)"
            />
            <span>{{ trayEnabled ? "启用" : "关闭" }}</span>
          </label>
          <span class="settings-hint">
            关闭托盘后不再常驻后台，点窗口「×」将直接退出应用（此时「关闭主窗口」选项不生效）
          </span>
        </div>
        <div class="settings-row">
          <span class="settings-label">关闭前询问</span>
          <label class="settings-toggle">
            <input
              type="checkbox"
              :checked="closeAsk"
              @change="persistCloseAsk(($event.target as HTMLInputElement).checked)"
            />
            <span>{{ closeAsk ? "每次询问" : "不再询问" }}</span>
          </label>
          <span class="settings-hint">
            首次关闭时询问「保留托盘 / 退出应用」；关闭询问后按「关闭主窗口」的选择直接执行
          </span>
        </div>
      </section>

      <!-- ---- 外观 / 主题 ---- -->
      <section class="settings-card">
        <h2 class="settings-title">主题</h2>
        <template v-if="!editing">
          <div class="theme-grid">
            <!-- 跟随系统：伪主题卡片（不在 listThemes 里，单独渲染） -->
            <div
              class="theme-card"
              :class="{ active: themeId === SYSTEM_THEME_ID }"
              role="button"
              tabindex="0"
              :aria-current="themeId === SYSTEM_THEME_ID ? 'true' : undefined"
              @click="onSetThemeId(SYSTEM_THEME_ID)"
              @keydown="onRowKeyDown($event, () => onSetThemeId(SYSTEM_THEME_ID))"
              title="跟随系统亮/暗模式自动切换"
            >
              <div class="theme-swatches">
                <!-- 亮/暗/自动三个色块示意（不依赖 swatchOf——system 不是真实主题） -->
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
              @keydown="onRowKeyDown($event, () => onSetThemeId(t.id))"
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
              <div class="theme-card-name">
                {{ t.name }}
                <span
                  v-if="t.source === 'plugin'"
                  class="theme-card-badge"
                  title="来自插件（皮肤插件，在插件页管理）"
                >
                  插件
                </span>
              </div>
              <div class="theme-card-desc">{{ t.description }}</div>
              <button
                v-if="t.custom"
                class="theme-delete"
                title="删除主题"
                :aria-label="`删除主题 ${t.name}`"
                @click.stop="confirmDelTheme = t"
              >
                <Icon name="trash" :size="12" />
              </button>
            </div>
          </div>
          <div class="theme-actions">
            <button class="btn btn-sm" @click="newTheme">
              <Icon name="plus" :size="12" />
              基于当前主题新建
            </button>
            <button class="btn btn-sm" @click="themeIo = !themeIo">
              {{ themeIo ? "收起导出/导入" : "导出 / 导入主题" }}
            </button>
            <span class="settings-hint">自定义主题保存在本机，可随时调整或删除</span>
          </div>
          <ThemeIoPanel
            v-if="themeIo"
            :on-done="() => {
              themeIo = false;
              themeVersion += 1;
            }"
          />
        </template>
        <ThemeEditor
          v-else
          :initial="editing"
          :on-cancel="() => {
            editing = null;
            onSetThemeId(themeId); // 恢复原主题
          }"
          :on-saved="(id: string) => {
            editing = null;
            onSetThemeId(id);
          }"
        />
      </section>

      <!-- ---- 备份 ---- -->
      <BackupSettings />

      <!-- ---- 日志（级别/目录/查看/清空；保留 7 天自动清理） ---- -->
      <LogSettings />

      <!-- ---- 导航栏 ---- -->
      <NavSettings :config="navConfig" :defs="defs" :on-change="onNavChange" />

      <!-- ---- 插件设置（manifest settings.entry 声明的插件自定义面板；手风琴，展开查看） ---- -->
      <section v-if="settingsPlugins.length > 0" class="settings-card">
        <h2 class="settings-title">插件设置</h2>
        <div class="settings-row">
          <span class="settings-hint">
            {{ settingsPlugins.length }} 个插件提供设置面板，点击展开（同时只展开一个）
          </span>
        </div>
        <div v-for="p in settingsPlugins" :key="p.id" class="plugin-settings-block">
          <button
            class="plugin-settings-head"
            :class="{ open: expandedPluginSettings === p.id }"
            :aria-expanded="expandedPluginSettings === p.id"
            @click="togglePluginSettings(p.id)"
          >
            <span class="plugin-settings-name">{{ p.name }}</span>
            <span class="plugin-settings-meta">{{ p.settings }}</span>
            <Icon
              name="chevron-down"
              :size="14"
              class="plugin-settings-caret"
              :class="{ open: expandedPluginSettings === p.id }"
            />
          </button>
          <Transition name="fade-slide">
            <div v-if="expandedPluginSettings === p.id" class="plugin-settings-pane">
              <PluginUiView
                :plugin-id="p.id"
                :entry="p.settings ?? 'ui/settings.js'"
                :reg-key="`settings:${p.id}`"
              />
            </div>
          </Transition>
        </div>
      </section>

      <!-- ---- 配置迁移 ---- -->
      <section class="settings-card">
        <h2 class="settings-title">配置迁移</h2>
        <div class="settings-row">
          <span class="settings-label">导入 / 导出</span>
          <div class="settings-actions">
            <button class="btn" @click="onExportConfig" :disabled="configBusy !== ''">
              {{ configBusy === "exporting" ? "导出中…" : "导出配置" }}
            </button>
            <button class="btn" @click="onImportConfig" :disabled="configBusy !== ''">
              {{ configBusy === "importing" ? "导入中…" : "导入配置" }}
            </button>
            <span class="settings-hint">
              主题、导航、AI 设置与插件启停状态（不含笔记数据与 API Key）
            </span>
          </div>
        </div>
        <div v-if="configMsg" class="settings-value">{{ configMsg }}</div>
      </section>

      <!-- ---- 关于 ---- -->
      <section class="settings-card">
        <h2 class="settings-title">关于</h2>
        <div class="settings-row">
          <span class="settings-label">ToolBox</span>
          <span class="settings-value">{{ APP_TAG }}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">核心版本</span>
          <span class="settings-value">{{ ping ? `v${ping.coreVersion}` : "—" }}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">平台</span>
          <span class="settings-value">{{ ping?.os ?? "—" }}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">IPC 链路</span>
          <span class="settings-value" :class="ok ? 'ok' : 'warn'">
            {{ ping ? ping.message : "连接中…" }}
          </span>
        </div>
        <div class="settings-row">
          <span class="settings-label">自动更新</span>
          <span class="settings-value">
            {{ updateStatusText }}
          </span>
          <button
            class="btn-ghost sm"
            @click="onCheckUpdate"
            :disabled="updateStatus === 'checking' || updateStatus === 'installing'"
            title="检查 GitHub Releases 是否有新版本"
          >
            {{
              updateStatus === "checking"
                ? "检查中…"
                : updateStatus === "installing"
                  ? "安装中…"
                  : "检查更新"
            }}
          </button>
        </div>
        <div v-if="updateStatus === 'error' && updateErr" class="settings-value warn" style="font-size: 11px; margin-top: 4px">
          {{ updateErr.slice(0, 120) }}
        </div>
      </section>
    </div>

    <ConfirmDialog
      :open="confirmDelTheme !== null"
      title="删除主题"
      :message="confirmDelTheme ? `确定删除自定义主题「${confirmDelTheme.name}」？` : ''"
      confirm-text="删除"
      danger
      :on-cancel="() => (confirmDelTheme = null)"
      :on-confirm="() => {
        if (confirmDelTheme) removeCustom(confirmDelTheme.id);
      }"
    />
  </div>
</template>
