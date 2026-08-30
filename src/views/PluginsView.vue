<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { open, save } from "@tauri-apps/plugin-dialog";
import { usePlugins } from "../core/plugins";
import { useVault } from "../core/vault";
import { useNav } from "../core/navigation";
import { useTauriListen } from "../core/useTauriListen";
import {
  pluginsRemovedCore,
  pluginsReinstallCore,
  pluginsInstall,
  pluginsInstallDeps,
  pluginsExport,
  pluginsDirGet,
  pluginsDirSet,
} from "../core/api";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import PluginCard from "../components/PluginCard.vue";
import Icon from "../components/Icon.vue";

/**
 * 插件页：插件卡片列表（核心/外部分组，启用/禁用/重载/卸载/「打开」跳转界面）、
 * 命令试用台（CommandTry）、实时事件流、DLL 插件安装（zip/目录）、
 * 已卸载核心插件一键恢复。分组/徽标/间距样式见 app.css .plugin-*。
 */

/** 事件桥载荷（与 Rust PluginEvent camelCase 对应） */
interface PluginEventPayload {
  pluginId: string;
  event: string;
  data: unknown;
}

interface PluginEventLog extends PluginEventPayload {
  time: number;
}

const vault = useVault();
const nav = useNav();
const pluginsCtx = usePlugins();

const busy = reactive<Record<string, boolean>>({});
const confirmDel = ref<string | null>(null);
/** 待安装的本地插件来源（.zip 包或目录），确认后安装 */
const pendingInstall = ref<{ path: string; kind: "zip" | "dir" } | null>(null);
/** 全局插件目录（当前生效；可自定义，切换时自动迁移） */
const pluginsDir = ref<string | null>(null);
const events = ref<PluginEventLog[]>([]);
/** 已卸载的核心插件 id（显示"重新安装"入口） */
const removedCore = ref<string[]>([]);
/** 操作错误提示（卸载/切换/重载失败时显示，可关闭） */
const actionError = ref<string | null>(null);
/** 依赖安装进行中（按插件 id；按钮显示"安装中…"） */
const depsBusy = reactive<Record<string, boolean>>({});
/** 依赖安装结果输出（pip stdout/stderr 尾部；成功后展示，可关闭） */
const depsResult = ref<{ id: string; output: string } | null>(null);

/** 导出插件为 .zip 包（分享/备份）：选择保存位置 → 后端打包目录全部内容 */
async function doExport(id: string): Promise<void> {
  const v = vault.state.path;
  if (!v) return;
  try {
    const sel = await save({
      title: "导出插件包",
      defaultPath: `${id}.zip`,
      filters: [{ name: "插件包", extensions: ["zip"] }],
    });
    if (typeof sel !== "string" || !sel) return; // 用户取消
    busy[id] = true;
    try {
      const path = await pluginsExport(v, id, sel);
      actionError.value = null;
      depsResult.value = { id, output: `已导出：${path}` };
    } catch (e) {
      actionError.value = `导出失败: ${e}`;
    } finally {
      busy[id] = false;
    }
  } catch {
    /* 对话框异常/取消 */
  }
}

/** 选择安装来源：.zip 包或插件目录（系统对话框） */
async function pickInstall(kind: "zip" | "dir"): Promise<void> {
  try {
    const sel =
      kind === "zip"
        ? await open({
            multiple: false,
            filters: [{ name: "插件压缩包", extensions: ["zip"] }],
          })
        : await open({ directory: true, multiple: false });
    if (typeof sel === "string" && sel) pendingInstall.value = { path: sel, kind };
  } catch {
    /* 用户取消 */
  }
}

async function doInstall(): Promise<void> {
  const v = vault.state.path;
  if (!v || !pendingInstall.value) return;
  const { path: src, kind } = pendingInstall.value;
  pendingInstall.value = null;
  busy["@install"] = true;
  try {
    await pluginsInstall(v, src, kind);
    await pluginsCtx.refresh();
  } catch (e) {
    actionError.value = `安装失败: ${e}`;
  } finally {
    busy["@install"] = false;
  }
}

/* 读取当前插件目录（自定义或默认） */
onMounted(() => {
  pluginsDirGet()
    .then((d) => (pluginsDir.value = d))
    .catch(() => (pluginsDir.value = null));
});

/** 更改插件目录：选择新目录 → 后端自动迁移（旧目录进回收站）→ 刷新 */
async function changePluginsDir(): Promise<void> {
  try {
    const sel = (await open({
      directory: true,
      title: "选择插件目录（现有插件将自动迁移）",
    })) as string | null;
    if (!sel) return;
    const effective = await pluginsDirSet(sel);
    pluginsDir.value = effective;
    await pluginsCtx.refresh();
    actionError.value = null;
  } catch (e) {
    actionError.value = `更改插件目录失败: ${e}`;
  }
}

/** 恢复默认插件目录（%APPDATA%）；现有插件自动迁移 */
async function resetPluginsDir(): Promise<void> {
  try {
    const effective = await pluginsDirSet("");
    pluginsDir.value = effective;
    await pluginsCtx.refresh();
  } catch (e) {
    actionError.value = `恢复默认插件目录失败: ${e}`;
  }
}

function loadRemoved(): void {
  pluginsRemovedCore()
    .then((ids) => (removedCore.value = ids))
    .catch(() => (removedCore.value = []));
}
onMounted(loadRemoved);

async function doReinstall(id: string): Promise<void> {
  const v = vault.state.path;
  if (!v) return;
  busy[id] = true;
  try {
    await pluginsReinstallCore(v, id);
    await pluginsCtx.refresh();
    loadRemoved();
  } catch (e) {
    actionError.value = `重新安装失败: ${e}`;
  } finally {
    busy[id] = false;
  }
}

/* 事件桥：进程插件推送的事件（plugin-event）实时追加到日志（useTauriListen
   统一处理异步 listen 与卸载竞态） */
useTauriListen<PluginEventPayload>("plugin-event", (payload) => {
  events.value = [...events.value, { ...payload, time: Date.now() }].slice(-50);
});

async function doUninstall(id: string): Promise<void> {
  busy[id] = true;
  try {
    await pluginsCtx.uninstall(id);
    loadRemoved();
  } catch (e) {
    actionError.value = `卸载失败: ${e}`;
  } finally {
    busy[id] = false;
  }
}

async function toggle(id: string, enabled: boolean): Promise<void> {
  busy[id] = true;
  try {
    await pluginsCtx.setEnabled(id, enabled);
  } catch (e) {
    actionError.value = `操作失败: ${e}`;
  } finally {
    busy[id] = false;
  }
}

async function doReload(id: string): Promise<void> {
  busy[id] = true;
  try {
    await pluginsCtx.reload(id);
  } catch (e) {
    actionError.value = `重载失败: ${e}`;
  } finally {
    busy[id] = false;
  }
}

/** 安装插件依赖：捆绑 Python 的 pip 装到 <插件>/vendor/，成功后重载插件生效 */
async function doInstallDeps(id: string): Promise<void> {
  const v = vault.state.path;
  if (!v) return;
  depsBusy[id] = true;
  try {
    const output = await pluginsInstallDeps(v, id);
    depsResult.value = { id, output };
    // 依赖就位后重启插件进程，让 sys.path 里的 vendor/ 生效
    try {
      await pluginsCtx.reload(id);
    } catch (e) {
      actionError.value = `依赖安装成功，但重新加载插件失败: ${e}`;
    }
  } catch (e) {
    actionError.value = `安装依赖失败: ${e}`;
  } finally {
    depsBusy[id] = false;
  }
}

/* 分组：核心插件（native，随应用分发）在前，外部插件在后 */
const corePlugins = () => pluginsCtx.state.plugins.filter((p) => p.builtin);
const externalPlugins = () => pluginsCtx.state.plugins.filter((p) => !p.builtin);

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function confirmMessage(id: string): string {
  const p = pluginsCtx.state.plugins.find((x) => x.id === id);
  return p?.builtin
    ? `确定卸载核心插件「${id}」？将彻底删除 DLL 与目录（不进回收站）；需要时可在本页「已卸载的核心插件」中一键重新安装。`
    : `确定卸载插件「${id}」？插件目录将移入系统回收站，启用状态一并清除。`;
}
</script>

<template>
  <div class="plugins-view">
    <header class="view-header">
      <div>
        <h1>插件</h1>
        <p class="view-sub">用 JS / Python 扩展 ToolBox 的能力</p>
      </div>
      <div class="view-actions">
        <button
          class="btn"
          title="安装插件包（.zip 压缩包，含 plugin.json；按运行时自动部署到对应位置）"
          @click="pickInstall('zip')"
          :disabled="!vault.state.path || pluginsCtx.state.loading"
        >
          安装 .zip
        </button>
        <button
          class="btn"
          title="安装插件目录（含 plugin.json；DLL 装到 _core\，JS/Python/主题皮肤装到插件目录根）"
          @click="pickInstall('dir')"
          :disabled="!vault.state.path || pluginsCtx.state.loading"
        >
          安装目录
        </button>
        <button class="btn" @click="pluginsCtx.refresh" :disabled="pluginsCtx.state.loading">
          <Icon name="refresh" :size="14" />
          {{ pluginsCtx.state.loading ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </header>

    <!-- 插件目录：默认 %APPDATA%，可自定义（切换时自动迁移） -->
    <div v-if="pluginsDir" class="plugins-dir-row">
      <span class="plugins-dir-label">插件目录</span>
      <code class="plugins-dir-path" :title="pluginsDir">{{ pluginsDir }}</code>
      <button class="btn btn-sm" @click="changePluginsDir">更改…</button>
      <button class="btn btn-sm" @click="resetPluginsDir">恢复默认</button>
      <span class="settings-hint">
        DLL 装到 <code>_core\</code>，JS / Python / 主题皮肤装到根目录；更改时现有插件自动迁移
      </span>
    </div>

    <!-- 操作错误（重载/启停/安装依赖失败）：紧凑提示条，不挤占卡片列表 -->
    <Transition name="fade-slide">
      <div v-if="actionError" class="action-bar action-bar-error">
        <span class="action-bar-text">{{ actionError }}</span>
        <button class="icon-btn sm" aria-label="关闭" @click="actionError = null">
          <Icon name="trash" :size="12" />
        </button>
      </div>
    </Transition>

    <!-- 依赖安装结果：pip 输出尾部（成功或部分输出），可关闭 -->
    <Transition name="fade-slide">
      <div v-if="depsResult" class="action-bar">
        <div class="action-bar-body">
          <p class="action-bar-title">
            <strong>「{{ depsResult.id }}」依赖安装完成</strong>（装到
            <code>vendor/</code>，插件已重新加载）。pip 输出：
          </p>
          <pre class="deps-output">{{ depsResult.output || "（无输出）" }}</pre>
        </div>
        <button class="icon-btn sm" aria-label="关闭" @click="depsResult = null">
          <Icon name="trash" :size="12" />
        </button>
      </div>
    </Transition>

    <template v-if="!vault.state.path">
      <div class="empty-state">
        <Icon name="gear" :size="28" />
        <p>请先在顶栏选择一个工作区，再管理插件</p>
      </div>
    </template>
    <template v-else-if="pluginsCtx.state.plugins.length === 0 && !pluginsCtx.state.loading">
      <div class="empty-state">
        <Icon name="gear" :size="28" />
        <p>工作区 plugins 目录下还没有插件</p>
        <code class="hint-path">plugins/&lt;插件id&gt;/plugin.json</code>
      </div>
    </template>
    <template v-else>
      <div class="plugin-list">
        <div class="plugin-group-label plugin-mount-hint">
          手动安装：把含 plugin.json 的插件目录放入插件目录——DLL（native）放
          <code>_core\&lt;id&gt;</code>，JS / Python / 主题皮肤直接放根目录
          （<code>plugins\&lt;id&gt;</code>），点「刷新」自动识别。
          <span style="opacity: 0.7">
            原生插件为本地代码，加载即在本机执行，仅安装可信来源。
          </span>
        </div>
        <div v-if="corePlugins().length > 0" class="plugin-group">
          <div class="plugin-group-label">
            核心插件（随应用分发 · 可启用/禁用/卸载；卸载后从资源一键重新安装）
          </div>
          <PluginCard
            v-for="p in corePlugins()"
            :key="p.id"
            :plugin="p"
            :busy="!!busy[p.id]"
            :runtime-error="pluginsCtx.state.runtimeErrors[p.id]"
            :commands="pluginsCtx.commandsOf(p.id)"
            :invoke="pluginsCtx.invoke"
            :on-toggle="toggle"
            :on-reload="doReload"
            :on-uninstall="(id: string) => (confirmDel = id)"
            :on-open="nav.go"
            :on-install-deps="doInstallDeps"
            :deps-busy="!!depsBusy[p.id]"
            :on-export="doExport"
          />
        </div>
        <div v-if="externalPlugins().length > 0" class="plugin-group">
          <div v-if="corePlugins().length > 0" class="plugin-group-label">外部插件</div>
          <PluginCard
            v-for="p in externalPlugins()"
            :key="p.id"
            :plugin="p"
            :busy="!!busy[p.id]"
            :runtime-error="pluginsCtx.state.runtimeErrors[p.id]"
            :commands="pluginsCtx.commandsOf(p.id)"
            :invoke="pluginsCtx.invoke"
            :on-toggle="toggle"
            :on-reload="doReload"
            :on-uninstall="(id: string) => (confirmDel = id)"
            :on-open="nav.go"
            :on-install-deps="doInstallDeps"
            :deps-busy="!!depsBusy[p.id]"
            :on-export="doExport"
          />
        </div>
      </div>
    </template>

    <div v-if="removedCore.length > 0" class="plugin-group" style="margin-top: 16px">
      <div class="plugin-group-label">已卸载的核心插件（可重新安装）</div>
      <section v-for="id in removedCore" :key="id" class="plugin-card">
        <div class="plugin-head">
          <div class="plugin-title">
            <h2>{{ id }}</h2>
            <span class="badge badge-runtime">原生</span>
            <span class="badge badge-status badge-status-stopped">已卸载</span>
          </div>
          <div class="plugin-actions">
            <button class="btn btn-sm" @click="doReinstall(id)" :disabled="!!busy[id]">
              {{ busy[id] ? "恢复中…" : "重新安装" }}
            </button>
          </div>
        </div>
        <p class="plugin-desc">
          已彻底删除（DLL 与目录）。重新安装将从随应用分发的资源恢复并启用。
        </p>
      </section>
    </div>

    <ConfirmDialog
      :open="confirmDel !== null"
      title="卸载插件"
      :message="confirmDel ? confirmMessage(confirmDel) : ''"
      confirm-text="卸载"
      danger
      :on-cancel="() => (confirmDel = null)"
      :on-confirm="() => {
        if (confirmDel) void doUninstall(confirmDel);
        confirmDel = null;
      }"
    />

    <ConfirmDialog
      :open="pendingInstall !== null"
      title="安装原生插件"
      :message="
        pendingInstall
          ? `将从「${pendingInstall.path}」安装 DLL 插件。原生插件为本地代码，加载即在本机执行（等同运行任意程序）——请确认来源可信。`
          : ''
      "
      confirm-text="安装"
      danger
      :on-cancel="() => (pendingInstall = null)"
      :on-confirm="doInstall"
    />

    <!-- 事件桥日志：进程插件实时推送的事件（Notification） -->
    <Transition name="fade-slide">
      <div v-if="events.length > 0" class="plugin-events">
        <div class="plugin-events-head">
          <span>插件事件（实时）</span>
          <button
            class="icon-btn sm"
            title="清空事件日志"
            aria-label="清空事件日志"
            @click="events = []"
          >
            <Icon name="trash" :size="12" />
          </button>
        </div>
        <div class="plugin-events-list">
          <div v-for="(e, i) in events.slice(-15).reverse()" :key="i" class="plugin-event">
            <span class="plugin-event-time">{{ fmtTime(e.time) }}</span>
            <span class="plugin-event-id">{{ e.pluginId }}</span>
            <span class="plugin-event-name">{{ e.event }}</span>
            <code class="plugin-event-data">{{ JSON.stringify(e.data) }}</code>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>
