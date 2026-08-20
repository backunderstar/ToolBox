<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import {
  BUILTIN_GROUPS,
  type NavConfig,
  type NavItemDef,
  type NavItemMeta,
} from "../core/navPrefs";
import { normalizeNav } from "../core/navPrefs";
import Icon from "./Icon.vue";
import MetaEditor from "./MetaEditor.vue";

/**
 * 设置页"导航栏"卡片（全配置）：
 * - 分组管理：新建 / 重命名（自定义组）/ 删除（组内项回默认组）
 * - 项：跨组移动（拖拽 drop 或每行的「移动到…」下拉，按钮式最可靠——
 *   WebView2 里 HTML5 拖拽不稳定）+ 组内上下移 + 隐藏开关 + 编辑（标签/图标覆盖，插件项也可改）
 * - 插件项的位置完全由用户配置（默认按插件声明 group 归组，可任意移动）
 */
const props = defineProps<{
  /** 归一化后的导航配置 */
  config: NavConfig;
  /** 全部导航项定义（静态 + 插件声明） */
  defs: NavItemDef[];
  onChange: (cfg: NavConfig) => void;
}>();

const defById = new Map(props.defs.map((d) => [d.id, d]));
const builtinIds = new Set(BUILTIN_GROUPS.map((g) => g.id));

const editing = ref<string | null>(null);
const newGroupOpen = ref(false);
const newGroupName = ref("");
/** 正在拖拽的项（视觉高亮） */
const drag = ref<{ itemId: string; from: string } | null>(null);
/** 拖拽悬停的目标组 id（高亮） */
const dragOver = ref<string | null>(null);
/** 拖拽源（pointer 事件闭包读取，避免响应式异步）与清理函数（卸载兜底） */
let dragRef: { itemId: string; from: string } | null = null;
let dragCleanup: (() => void) | null = null;

/* 卸载兜底：拖拽中离开设置页时移除 window 上的 pointer 监听，避免泄漏 */
onBeforeUnmount(() => dragCleanup?.());

const orderOf = (groupId: string): string[] => props.config.order[groupId] ?? [];

/* ---- 项操作 ---- */

function moveWithin(groupId: string, itemId: string, dir: -1 | 1): void {
  const order = [...orderOf(groupId)];
  const idx = order.indexOf(itemId);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= order.length) return;
  [order[idx], order[target]] = [order[target], order[idx]];
  props.onChange({ ...props.config, order: { ...props.config.order, [groupId]: order } });
}

/** 跨组移动（拖拽 drop）：从原组移除，追加到目标组末尾 */
function moveToGroup(itemId: string, from: string, to: string): void {
  if (from === to) return;
  const order = { ...props.config.order };
  order[from] = (order[from] ?? []).filter((id) => id !== itemId);
  const target = order[to] ?? [];
  if (!target.includes(itemId)) target.push(itemId);
  order[to] = target;
  props.onChange({ ...props.config, order });
}

/**
 * 自定义拖拽（Pointer Events）：WebView2 的 HTML5 DnD 走系统拖放协议不稳定
 * （拖动行时 drop 经常不触发），pointer 方案完全在前端可控：
 * 行上按下（避开按钮/输入框等交互元素）→ 拖动时高亮悬停的组 → 松手即跨组移动。
 */
function startRowDrag(e: PointerEvent, itemId: string, from: string): void {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement;
  if (t.closest("button, input, select, textarea, label")) return;
  // 阻止默认：防拖动时选中文本/触发浏览器原生拖拽
  e.preventDefault();
  dragRef = { itemId, from };
  drag.value = { itemId, from };
  // 拖动期间禁用文本选中（防止 pointermove 拖动行时误选文字）
  document.body.classList.add("nav-dragging");
  const move = (ev: PointerEvent) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    dragOver.value = el?.closest<HTMLElement>(".nav-settings-group")?.dataset.groupId ?? null;
  };
  const cleanup = () => {
    document.body.classList.remove("nav-dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    dragCleanup = null;
  };
  const up = (ev: PointerEvent) => {
    cleanup();
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const to = el?.closest<HTMLElement>(".nav-settings-group")?.dataset.groupId;
    const d = dragRef;
    dragRef = null;
    drag.value = null;
    dragOver.value = null;
    if (d && to && d.from !== to) moveToGroup(d.itemId, d.from, to);
  };
  // pointercancel（系统取消手势/窗口外松手）：只清理，不做 drop
  const cancel = () => {
    cleanup();
    dragRef = null;
    drag.value = null;
    dragOver.value = null;
  };
  dragCleanup = cleanup;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
}

function toggleHidden(itemId: string): void {
  const cur = props.config.meta[itemId]?.hidden;
  const meta = { ...props.config.meta };
  const next: NavItemMeta = { ...meta[itemId] };
  if (cur) delete next.hidden;
  else next.hidden = true;
  if (Object.keys(next).length === 0) delete meta[itemId];
  else meta[itemId] = next;
  props.onChange({ ...props.config, meta });
}

function saveMeta(itemId: string, patch: NavItemMeta): void {
  const meta = { ...props.config.meta };
  const next: NavItemMeta = { ...meta[itemId], ...patch };
  if (Object.keys(next).length === 0) delete meta[itemId];
  else meta[itemId] = next;
  props.onChange({ ...props.config, meta });
  editing.value = null;
}

/* ---- 分组操作 ---- */

function addGroup(): void {
  const name = newGroupName.value.trim();
  if (!name) return;
  const id = `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  props.onChange({
    ...props.config,
    groups: [...props.config.groups, { id, label: name }],
    order: { ...props.config.order, [id]: [] },
  });
  newGroupName.value = "";
  newGroupOpen.value = false;
}

/** 分组名即时更新（不 trim，输入过程保留空格）；blur 时 trim 最终化 */
function setGroupLabel(groupId: string, label: string): void {
  props.onChange({
    ...props.config,
    groups: props.config.groups.map((g) => (g.id === groupId ? { ...g, label } : g)),
  });
}

/** blur/Enter 最终化：去首尾空格；全空则还原（不允许空名分组） */
function commitGroupLabel(groupId: string, label: string): void {
  const t = label.trim();
  if (!t) {
    setGroupLabel(groupId, props.config.groups.find((g) => g.id === groupId)?.label ?? "");
    return;
  }
  if (t !== label) setGroupLabel(groupId, t);
}

/** 删除分组：组内项移回各自默认组，再移除组 */
function deleteGroup(groupId: string): void {
  const order = { ...props.config.order };
  const moved = order[groupId] ?? [];
  delete order[groupId];
  for (const id of moved) {
    const def = defById.get(id);
    // 注意优先级：`??` 先于 `?:`，必须用括号把三元包住，否则解析成
    // `(def?.groupId ?? builtinIds.has(groupId)) ? "work" : "system"`，
    // 只要 def 存在就恒取 "work"，把默认组为 system 的项（blog/ai）误移入 work。
    const fallback = def?.groupId ?? (builtinIds.has(groupId) ? "work" : "system");
    const list = order[fallback] ?? (order[fallback] = []);
    if (!list.includes(id)) list.push(id);
  }
  props.onChange({
    ...props.config,
    groups: props.config.groups.filter((g) => g.id !== groupId),
    order,
  });
}

function reset(): void {
  props.onChange(normalizeNav(null, props.defs));
}
</script>

<template>
  <section class="settings-card">
    <h2 class="settings-title">导航栏</h2>
    <div class="settings-row">
      <span class="settings-label">说明</span>
      <span class="settings-hint">
        左侧导航完全可配置：新建/重命名分组（内置"工作区/系统"也可改名），
        按住任意项（含插件项）拖到其他分组、组内上下移调整顺序、隐藏、改名换图标；
        "设置"固定显示。插件禁用后其入口消失，恢复启用时回到你配置的位置。
      </span>
    </div>

    <div
      v-for="group in config.groups"
      :key="group.id"
      class="nav-settings-group"
      :class="{ 'drag-over': dragOver === group.id }"
      :data-group-id="group.id"
    >
      <div class="nav-settings-group-head">
        <input
          class="nav-settings-group-name"
          :value="group.label"
          :title="builtinIds.has(group.id) ? '内置分组，名称可改（插件归组不受影响）' : '分组名称'"
          @input="setGroupLabel(group.id, ($event.target as HTMLInputElement).value)"
          @blur="commitGroupLabel(group.id, ($event.target as HTMLInputElement).value)"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          spellcheck="false"
        />
        <span class="nav-settings-group-meta">
          {{
            builtinIds.has(group.id)
              ? "内置"
              : (orderOf(group.id) ?? []).length === 0
                ? "空分组"
                : `${(orderOf(group.id) ?? []).length} 项`
          }}
          <button
            v-if="!builtinIds.has(group.id)"
            class="icon-btn sm danger"
            title="删除分组（组内项回默认组）"
            @click="deleteGroup(group.id)"
          >
            <Icon name="trash" :size="12" />
          </button>
        </span>
      </div>

      <div
        v-if="(orderOf(group.id) ?? []).length === 0"
        class="nav-settings-empty"
      >
        把导航项拖到这里（按住行拖动）
      </div>
      <div
        v-for="item in orderOf(group.id)
          .map((id) => defById.get(id))
          .filter((d): d is NavItemDef => !!d)"
        :key="item.id"
        class="nav-settings-row"
        :class="{
          hidden: config.meta[item.id]?.hidden,
          dragging: drag?.itemId === item.id,
        }"
        @pointerdown="startRowDrag($event, item.id, group.id)"
      >
        <span class="nav-settings-name">
          <span class="nav-settings-icon">
            <Icon :name="config.meta[item.id]?.icon ?? item.icon" :size="13" />
          </span>
          <span class="nav-settings-label">
            {{ config.meta[item.id]?.label ?? item.label }}
            <span v-if="item.fixed" class="nav-settings-fixed">固定</span>
            <span v-if="config.meta[item.id]?.hidden" class="nav-settings-hidden">已隐藏</span>
          </span>
          <span class="nav-settings-from" title="来源">
            {{ defById.get(item.id)?.groupId === group.id ? "" : "已移动" }}
          </span>
        </span>
        <span class="nav-settings-actions">
          <MetaEditor
            v-if="editing === item.id"
            :initial-label="config.meta[item.id]?.label ?? item.label"
            :initial-icon="config.meta[item.id]?.icon ?? item.icon"
            :on-save="(patch: NavItemMeta) => saveMeta(item.id, patch)"
            :on-cancel="() => (editing = null)"
          />
          <template v-else>
            <button
              class="icon-btn sm"
              title="上移"
              :disabled="orderOf(group.id).indexOf(item.id) <= 0"
              @click="moveWithin(group.id, item.id, -1)"
            >
              <Icon name="arrow-up" :size="13" />
            </button>
            <button
              class="icon-btn sm"
              title="下移"
              :disabled="orderOf(group.id).indexOf(item.id) >= orderOf(group.id).length - 1"
              @click="moveWithin(group.id, item.id, 1)"
            >
              <Icon name="arrow-down" :size="13" />
            </button>
            <button class="icon-btn sm" title="编辑标签/图标（仅本应用内显示）" @click="editing = item.id">
              ✎
            </button>
            <label
              class="switch"
              :class="{ disabled: item.id === 'settings' }"
              :title="
                item.id === 'settings'
                  ? '设置固定显示'
                  : config.meta[item.id]?.hidden
                    ? '点击显示'
                    : '点击隐藏'
              "
            >
              <input
                type="checkbox"
                :checked="!config.meta[item.id]?.hidden"
                :disabled="item.id === 'settings'"
                :aria-label="
                  item.id === 'settings'
                    ? '设置固定显示'
                    : config.meta[item.id]?.hidden
                      ? `显示「${config.meta[item.id]?.label ?? item.label}」`
                      : `隐藏「${config.meta[item.id]?.label ?? item.label}」`
                "
                @change="toggleHidden(item.id)"
              />
              <span class="switch-track" />
            </label>
          </template>
        </span>
      </div>
    </div>

    <div class="settings-row">
      <span class="settings-label">分组</span>
      <div class="settings-actions">
        <span v-if="newGroupOpen" class="nav-settings-newgroup">
          <input
            class="nav-settings-newgroup-input"
            v-model="newGroupName"
            @keydown.enter="addGroup"
            @keydown.esc="newGroupOpen = false"
            placeholder="分组名称…"
            spellcheck="false"
          />
          <button class="btn btn-sm" @click="addGroup" :disabled="!newGroupName.trim()">
            创建
          </button>
          <button class="btn btn-sm" @click="newGroupOpen = false">取消</button>
        </span>
        <button v-else class="btn btn-sm" @click="newGroupOpen = true">
          <Icon name="plus" :size="12" />
          新建分组
        </button>
        <button class="btn btn-sm" @click="reset">恢复默认</button>
      </div>
    </div>
  </section>
</template>
