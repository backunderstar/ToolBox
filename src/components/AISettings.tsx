import { useEffect, useState } from "react";
import {
  aiConfigGet,
  aiConfigSet,
  aiConfigClearKey,
  aiTest,
  type AiConfig,
} from "../core/api";

/**
 * 设置页 AI 区块（M6）：提供商配置（OpenAI 兼容）+ 连通性测试。
 */
export function AISettings() {
  const [form, setForm] = useState<AiConfig>({
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-chat",
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  useEffect(() => {
    aiConfigGet()
      .then((c) => {
        setForm(c);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await aiConfigSet(form);
      setMessage({ ok: true, text: "配置已保存" });
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setMessage(null);
    try {
      // 先保存当前表单再测试，保证测试的是最新配置
      await aiConfigSet(form);
      const reply = await aiTest();
      setMessage({ ok: true, text: `连接成功：${reply.slice(0, 80)}` });
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async () => {
    try {
      await aiConfigClearKey();
      setForm((f) => ({ ...f, apiKey: "" }));
      setMessage({ ok: true, text: "API Key 已清除" });
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    }
  };

  return (
    <section className="settings-card">
      <h2 className="settings-title">AI 提供商</h2>
      {!loaded ? (
        <div className="settings-hint">加载配置…</div>
      ) : (
        <>
          <div className="settings-row">
            <span className="settings-label">API 地址</span>
            <input
              className="ai-input"
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              placeholder="https://api.deepseek.com"
              spellCheck={false}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">API Key</span>
            <input
              className="ai-input"
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={form.apiKey ? "已配置（输入可修改）" : "sk-…"}
              spellCheck={false}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">模型</span>
            <input
              className="ai-input ai-input-sm"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="deepseek-chat"
              spellCheck={false}
            />
          </div>
          <div className="settings-row">
            <span className="settings-label">操作</span>
            <div className="settings-actions">
              <button className="btn" onClick={() => void save()} disabled={saving}>
                {saving ? "保存中…" : "保存配置"}
              </button>
              <button className="btn" onClick={() => void test()} disabled={testing || !form.apiKey.trim()}>
                {testing ? "测试中…" : "测试连接"}
              </button>
              {form.apiKey && (
                <button className="btn" onClick={() => void clearKey()}>
                  清除 Key
                </button>
              )}
            </div>
          </div>
          <p className="settings-hint">
            兼容 OpenAI 协议（DeepSeek / OpenAI / 通义等）。Key 仅保存在本机。
          </p>
          {message && (
            <p className={`settings-message ${message.ok ? "ok" : "err"}`}>
              {message.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
