<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useVault } from "../core/vault";
import {
  backupConfigGet,
  backupConfigSet,
  backupList,
  backupNow,
  backupRestore,
  openInExplorer,
} from "../core/api";
import type { BackupConfig, BackupEntry } from "../core/api";
import Icon from "./Icon.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

/**
 * 设置页「备份」卡片：
 * 自动备份开关/间隔/保留份数 + 立即备份 + 备份列表 + 打开备份文件夹。
 * 数据落盘到 .toolbox/backups/，配置存应用配置目录。
 */
const vault = useVault();
const config = ref<BackupConfig | null>(null);
const entries = ref<BackupEntry[]>([]);
const busy = ref(false);
const msg = ref<string | null>(null);
const msgErr = ref(false);
const confirmRestore = ref<BackupEntry | null>(null);

function showMsg(text: string, isErr = false): void {
  msg.value = text;
  msgErr.value = isErr;
}

/** 防抖定时器：连续输入间隔/保留份数只触发一次落盘与提示 */
let saveTimer: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer);
});

onMounted(() => {
  void backupConfigGet()
    .then((c) => (config.value = c))
    .catch(() => (config.value = null));
});

async function loadList(): Promise<void> {
  if (!vault.state.path) return;
  try {
    entries.value = await backupList(vault.state.path);
  } catch {
    entries.value = [];
  }
}
watch(
  () => vault.state.path,
  () => void loadList(),
  { immediate: true },
);

async function save(next: BackupConfig): Promise<void> {
  // 立即保存（开关等单次操作）：先清掉在途的防抖定时器，避免旧值后到覆盖新值
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  config.value = next;
  try {
    await backupConfigSet(next);
    showMsg("备份设置已保存");
  } catch (e) {
    showMsg(String(e), true);
  }
}

/** 防抖保存：间隔/保留份数输入每键更新 UI，停顿 400ms 才落盘（避免每键一次 IPC） */
function saveSoon(next: BackupConfig): void {
  config.value = next;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save(next);
  }, 400);
}

async function doBackup(): Promise<void> {
  if (!vault.state.path || busy.value) return;
  busy.value = true;
  msg.value = null;
  try {
    const info = await backupNow(vault.state.path);
    showMsg(
      `备份完成：${info.fileCount} 个文件，${formatSize(info.sizeBytes)}（含配置与插件存档，保留最近 ${config.value?.keep ?? 10} 份）`,
    );
    await loadList();
  } catch (e) {
    showMsg(String(e), true);
  } finally {
    busy.value = false;
  }
}

/** 恢复到备份点：恢复前自动保存当前状态；覆盖合并（保留备份后新增的文件） */
async function doRestore(b: BackupEntry): Promise<void> {
  if (!vault.state.path || busy.value) return;
  busy.value = true;
  msg.value = null;
  try {
    await backupRestore(vault.state.path, b.name);
    showMsg(
      `已恢复到 ${new Date(b.timestamp * 1000).toLocaleString("zh-CN", { hour12: false })}（恢复前已自动保存当前状态）`,
    );
    await loadList();
  } catch (e) {
    showMsg(String(e), true);
  } finally {
    busy.value = false;
  }
}

async function openFolder(): Promise<void> {
  if (!vault.state.path) return;
  try {
    await openInExplorer(`${vault.state.path}\\.toolbox\\backups`);
  } catch (e) {
    showMsg(String(e), true);
  }
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let i = -1;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <section class="settings-card">
    <h2 class="settings-title">备份</h2>
    <template v-if="!vault.state.path">
      <div class="settings-row">
        <span class="settings-label">自动备份</span>
        <span class="settings-hint">选择工作区后可配置与手动备份</span>
      </div>
    </template>
    <template v-else>
      <div class="settings-row">
        <span class="settings-label">自动备份</span>
        <label class="tool-check">
          <input
            type="checkbox"
            :checked="config?.enabled ?? true"
            @change="config && save({ ...config, enabled: ($event.target as HTMLInputElement).checked })"
          />
          启用（应用运行期间按间隔自动备份）
        </label>
      </div>

      <div class="settings-row">
        <span class="settings-label">间隔（分钟）</span>
        <input
          class="settings-input"
          type="number"
          min="1"
          :value="config?.intervalMinutes ?? 30"
          @change="
            config &&
              saveSoon({
                ...config,
                intervalMinutes: Math.max(1, Number(($event.target as HTMLInputElement).value) || 30),
              })
          "
        />
      </div>

      <div class="settings-row">
        <span class="settings-label">保留份数</span>
        <input
          class="settings-input"
          type="number"
          min="1"
          max="99"
          :value="config?.keep ?? 10"
          @change="
            config &&
              saveSoon({
                ...config,
                keep: Math.max(1, Number(($event.target as HTMLInputElement).value) || 10),
              })
          "
        />
      </div>

      <div class="settings-row">
        <span class="settings-label">上次备份</span>
        <span class="settings-value">
          {{ config?.lastBackupAt ? fmtTime(config.lastBackupAt) : "尚未备份" }}
        </span>
      </div>

      <div class="settings-row">
        <span class="settings-label">操作</span>
        <div class="settings-actions">
          <button class="btn" @click="doBackup" :disabled="busy">
            <Icon name="refresh" :size="13" />
            {{ busy ? "备份中…" : "立即备份" }}
          </button>
          <button class="btn" @click="openFolder">打开备份文件夹</button>
        </div>
      </div>

      <div v-if="msg" class="settings-message" :class="msgErr ? 'err' : 'ok'">{{ msg }}</div>

      <div v-if="entries.length > 0" class="backup-list">
        <div class="backup-list-label">已有备份（{{ entries.length }}）</div>
        <div v-for="b in [...entries].reverse()" :key="b.name" class="backup-row">
          <span class="backup-time">{{ fmtTime(b.timestamp) }}</span>
          <span class="backup-size">{{ formatSize(b.sizeBytes) }}</span>
          <span v-if="b.hasConfig" class="badge badge-version" title="含 %APPDATA% 配置存档">
            配置
          </span>
          <span v-if="b.hasPlugins" class="badge badge-version" title="含全局插件目录存档">
            插件
          </span>
          <button
            class="btn btn-sm"
            title="恢复到该备份点（恢复前自动保存当前状态）"
            @click="confirmRestore = b"
            :disabled="busy"
          >
            恢复
          </button>
        </div>
      </div>

      <ConfirmDialog
        :open="confirmRestore !== null"
        title="恢复到备份点"
        :message="
          confirmRestore
            ? `将工作区恢复到 ${fmtTime(confirmRestore.timestamp)} 的备份。\n恢复前会自动保存当前状态（可反悔）；备份中存在的文件会被还原，备份后新增的文件保留。`
            : ''
        "
        confirm-text="恢复"
        danger
        :on-cancel="() => (confirmRestore = null)"
        :on-confirm="() => {
          if (confirmRestore) void doRestore(confirmRestore);
          confirmRestore = null;
        }"
      />
    </template>
  </section>
</template>
