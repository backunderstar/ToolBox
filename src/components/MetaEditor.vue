<script setup lang="ts">
import { ref } from "vue";
import type { NavItemMeta } from "../core/navPrefs";
import { ICON_NAMES } from "./icons";

/** 项标签/图标编辑小表单（覆盖默认值，仅本应用内显示） */
const props = defineProps<{
  initialLabel: string;
  initialIcon: string;
  onSave: (patch: NavItemMeta) => void;
  onCancel: () => void;
}>();

const label = ref(props.initialLabel);
const icon = ref(props.initialIcon);

function save(): void {
  props.onSave({ label: label.value.trim() || undefined, icon: icon.value });
}
</script>

<template>
  <span class="nav-settings-meta-editor">
    <input
      class="nav-settings-meta-label"
      v-model="label"
      @keydown.enter="save"
      @keydown.esc="onCancel"
      placeholder="标签"
      spellcheck="false"
    />
    <select class="nav-settings-meta-icon" v-model="icon" title="图标">
      <option v-for="n in ICON_NAMES" :key="n" :value="n">{{ n }}</option>
    </select>
    <button class="btn btn-sm" @click="save">保存</button>
    <button class="btn btn-sm" @click="onCancel">取消</button>
  </span>
</template>
