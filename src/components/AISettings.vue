<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  aiConfigGet,
  aiConfigSet,
  aiConfigSetKey,
  aiConfigClearKey,
  aiTest,
} from "../core/api";

/**
 * 设置页 AI 区块（M6）：提供商配置（OpenAI 兼容）+ 连通性测试。
 * API Key 存系统凭据管理器（Windows 凭据管理器 / Keychain），不落盘明文；
 * ai.json 只保存 baseUrl / model。
 */
const form = reactive({ baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
const keyInput = ref("");
const hasKey = ref(false);
const loaded = ref(false);
const saving = ref(false);
const testing = ref(false);
const message = ref<{ ok: boolean; text: string } | null>(null);

onMounted(() => {
  aiConfigGet()
    .then((c) => {
      form.baseUrl = c.baseUrl;
      form.model = c.model;
      hasKey.value = c.hasKey;
      loaded.value = true;
    })
    .catch(() => (loaded.value = true));
});

/** 保存表单 + 若有新输入的 Key 一并存入凭据管理器 */
async function save(): Promise<void> {
  saving.value = true;
  message.value = null;
  try {
    await aiConfigSet({ baseUrl: form.baseUrl, model: form.model });
    if (keyInput.value.trim()) {
      await aiConfigSetKey(keyInput.value);
      keyInput.value = "";
      hasKey.value = true;
      message.value = { ok: true, text: "配置与 API Key 已保存（Key 存系统凭据管理器）" };
    } else {
      message.value = { ok: true, text: "配置已保存" };
    }
  } catch (e) {
    message.value = { ok: false, text: String(e) };
  } finally {
    saving.value = false;
  }
}

async function test(): Promise<void> {
  testing.value = true;
  message.value = null;
  try {
    // 先保存最新配置与新 Key 再测试
    await aiConfigSet({ baseUrl: form.baseUrl, model: form.model });
    if (keyInput.value.trim()) await aiConfigSetKey(keyInput.value);
    const reply = await aiTest();
    message.value = { ok: true, text: `连接成功：${reply.slice(0, 80)}` };
  } catch (e) {
    message.value = { ok: false, text: String(e) };
  } finally {
    testing.value = false;
  }
}

async function clearKey(): Promise<void> {
  try {
    await aiConfigClearKey();
    hasKey.value = false;
    keyInput.value = "";
    message.value = { ok: true, text: "API Key 已从凭据管理器清除" };
  } catch (e) {
    message.value = { ok: false, text: String(e) };
  }
}
</script>

<template>
  <section class="settings-card">
    <h2 class="settings-title">AI 提供商</h2>
    <div v-if="!loaded" class="settings-hint">加载配置…</div>
    <template v-else>
      <div class="settings-row">
        <span class="settings-label">API 地址</span>
        <input
          class="ai-input"
          v-model="form.baseUrl"
          placeholder="https://api.deepseek.com"
          spellcheck="false"
        />
      </div>
      <div class="settings-row">
        <span class="settings-label">
          API Key
          <span v-if="hasKey" class="ai-key-state">已配置</span>
        </span>
        <input
          class="ai-input"
          type="password"
          v-model="keyInput"
          placeholder="sk-…"
          spellcheck="false"
        />
      </div>
      <div class="settings-row">
        <span class="settings-label">模型</span>
        <input
          class="ai-input ai-input-sm"
          v-model="form.model"
          placeholder="deepseek-chat"
          spellcheck="false"
        />
      </div>
      <div class="settings-row">
        <span class="settings-label">操作</span>
        <div class="settings-actions">
          <button class="btn" @click="save" :disabled="saving">
            {{ saving ? "保存中…" : "保存配置" }}
          </button>
          <button class="btn" @click="test" :disabled="testing || (!hasKey && !keyInput.trim())">
            {{ testing ? "测试中…" : "测试连接" }}
          </button>
          <button v-if="hasKey" class="btn" @click="clearKey">清除 Key</button>
        </div>
      </div>
      <p class="settings-hint">
        兼容 OpenAI 协议（DeepSeek / OpenAI / 通义等）。API Key 存系统凭据管理器，
        不写入任何配置文件。
      </p>
      <p v-if="message" class="settings-message" :class="message.ok ? 'ok' : 'err'">
        {{ message.text }}
      </p>
    </template>
  </section>
</template>
