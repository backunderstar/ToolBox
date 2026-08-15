import { useEffect, useState } from "react";
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
export function AISettings() {
  const [form, setForm] = useState({ baseUrl: "https://api.deepseek.com", model: "deepseek-chat" });
  const [keyInput, setKeyInput] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    aiConfigGet()
      .then((c) => {
        setForm({ baseUrl: c.baseUrl, model: c.model });
        setHasKey(c.hasKey);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  /** 保存表单 + 若有新输入的 Key 一并存入凭据管理器 */
  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await aiConfigSet(form);
      if (keyInput.trim()) {
        await aiConfigSetKey(keyInput);
        setKeyInput("");
        setHasKey(true);
        setMessage({ ok: true, text: "配置与 API Key 已保存（Key 存系统凭据管理器）" });
      } else {
        setMessage({ ok: true, text: "配置已保存" });
      }
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
      // 先保存最新配置与新 Key 再测试
      await aiConfigSet(form);
      if (keyInput.trim()) await aiConfigSetKey(keyInput);
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
      setHasKey(false);
      setKeyInput("");
      setMessage({ ok: true, text: "API Key 已从凭据管理器清除" });
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
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={hasKey ? "已配置（输入可修改）" : "sk-…"}
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
              <button className="btn" onClick={() => void test()} disabled={testing || (!hasKey && !keyInput.trim())}>
                {testing ? "测试中…" : "测试连接"}
              </button>
              {hasKey && (
                <button className="btn" onClick={() => void clearKey()}>
                  清除 Key
                </button>
              )}
            </div>
          </div>
          <p className="settings-hint">
            兼容 OpenAI 协议（DeepSeek / OpenAI / 通义等）。API Key 存系统凭据管理器，
            不写入任何配置文件。
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
