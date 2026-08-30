<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import type { NavConfig, NavItemDef } from "../core/navPrefs";
import type { ViewId } from "../core/navigation";

/**
 * 侧边栏（应用外壳）：按 navPrefs 归一化配置渲染分组/项（折叠、隐藏、
 * 图标覆盖、插件动态项），点击切换视图；ViewId 是宿主导航的视图联合类型
 * （插件视图 id 为字符串，App 按 nav 表动态路由）。
 */
const props = defineProps<{
  activeView: ViewId;
  onSelect: (view: ViewId) => void;
  /** 侧边栏整体折叠（窄模式，仅图标） */
  collapsed: boolean;
  /** 归一化后的导航配置（分组 + 项顺序 + 元数据覆盖） */
  config: NavConfig;
  /** 全部项定义（静态 + 插件 nav 声明） */
  defs: NavItemDef[];
  /** 切换分组折叠（记忆） */
  onToggleGroup: (groupId: string) => void;
}>();

const defById = computed(() => new Map(props.defs.map((d) => [d.id, d])));

/** 归一化后的分组渲染表：过滤隐藏/未知项，空组跳过 */
const groups = computed(() =>
  props.config.groups
    .map((group) => {
      const items = (props.config.order[group.id] ?? [])
        .map((id) => {
          const def = defById.value.get(id);
          if (!def) return null;
          if (props.config.meta[id]?.hidden) return null;
          const meta = props.config.meta[id];
          return { id, label: meta?.label ?? def.label, icon: meta?.icon ?? def.icon };
        })
        .filter((x): x is { id: string; label: string; icon: string } => !!x);
      return { group, items };
    })
    .filter((g) => g.items.length > 0),
);
</script>

<template>
  <nav
    class="sidebar"
    :class="{ collapsed }"
    aria-label="主导航"
    data-part="sidebar"
  >
    <div v-for="g in groups" :key="g.group.id" class="nav-group">
      <button
        v-if="!collapsed"
        class="nav-group-head"
        @click="onToggleGroup(g.group.id)"
        :title="g.group.collapsed ? `展开「${g.group.label}」` : `折叠「${g.group.label}」`"
      >
        <span class="nav-label">{{ g.group.label }}</span>
        <span class="nav-group-caret">
          <Icon :name="g.group.collapsed ? 'chevron-right' : 'chevron-down'" :size="11" />
        </span>
      </button>
      <template v-if="!collapsed ? !g.group.collapsed : true">
        <!-- 折叠时忽略组折叠状态显示全部项（组归属靠分隔线 + tooltip 组名前缀传达）；
             展开时按用户分组折叠记忆渲染 -->
        <button
          v-for="item in g.items"
          :key="item.id"
          class="nav-item"
          :class="{ active: item.id === activeView }"
          :aria-current="item.id === activeView ? 'page' : undefined"
          :title="collapsed ? `${g.group.label} · ${item.label}` : item.label"
          @click="onSelect(item.id as ViewId)"
        >
          <Icon :name="item.icon" :size="16" />
          <span v-if="!collapsed">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </nav>
</template>
