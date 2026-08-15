import { useEffect, useState } from "react";
import { useVault } from "../core/vault";
import {
  backupConfigGet,
  backupConfigSet,
  backupList,
  backupNow,
  openInExplorer,
} from "../core/api";
import type { BackupConfig, BackupEntry } from "../core/api";
import { IconRefresh } from "./icons";

/**
 * 设置页「备份」卡片：
 * 自动备份开关/间隔/保留份数 + 立即备份 + 备份列表 + 打开备份文件夹。
 * 数据落盘到 .toolbox/backups/，配置存应用配置目录。
 */
export function BackupSettings() {
  const vault = useVault();
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [entries, setEntries] = useState<BackupEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgErr, setMsgErr] = useState(false);
  const showMsg = (text: string, isErr = false) => {
    setMsg(text);
    setMsgErr(isErr);
  };

  useEffect(() => {
    void backupConfigGet().then(setConfig).catch(() => setConfig(null));
  }, []);

  const loadList = async () => {
    if (!vault.path) return;
    try {
      setEntries(await backupList(vault.path));
    } catch {
      setEntries([]);
    }
  };
  useEffect(() => {
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault.path]);

  const save = async (next: BackupConfig) => {
    setConfig(next);
    try {
      await backupConfigSet(next);
      showMsg("备份设置已保存");
    } catch (e) {
      showMsg(String(e), true);
    }
  };

  const doBackup = async () => {
    if (!vault.path || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const info = await backupNow(vault.path);
      showMsg(
        `备份完成：${info.fileCount} 个文件，${formatSize(info.sizeBytes)}（保留最近 ${config?.keep ?? 10} 份）`
      );
      await loadList();
    } catch (e) {
      showMsg(String(e), true);
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    if (!vault.path) return;
    try {
      await openInExplorer(`${vault.path}\\.toolbox\\backups`);
    } catch (e) {
      showMsg(String(e), true);
    }
  };

  if (!vault.path) {
    return (
      <section className="settings-card">
        <h2 className="settings-title">备份</h2>
        <div className="settings-row">
          <span className="settings-label">自动备份</span>
          <span className="settings-hint">选择工作区后可配置与手动备份</span>
        </div>
      </section>
    );
  }

  const lastText = config?.lastBackupAt
    ? new Date(config.lastBackupAt * 1000).toLocaleString("zh-CN", { hour12: false })
    : "尚未备份";

  return (
    <section className="settings-card">
      <h2 className="settings-title">备份</h2>

      <div className="settings-row">
        <span className="settings-label">自动备份</span>
        <label className="tool-check">
          <input
            type="checkbox"
            checked={config?.enabled ?? true}
            onChange={(e) =>
              config && save({ ...config, enabled: e.target.checked })
            }
          />
          启用（应用运行期间按间隔自动备份）
        </label>
      </div>

      <div className="settings-row">
        <span className="settings-label">间隔（分钟）</span>
        <input
          className="settings-input"
          type="number"
          min={1}
          value={config?.intervalMinutes ?? 30}
          onChange={(e) =>
            config &&
            save({ ...config, intervalMinutes: Math.max(1, Number(e.target.value) || 30) })
          }
        />
      </div>

      <div className="settings-row">
        <span className="settings-label">保留份数</span>
        <input
          className="settings-input"
          type="number"
          min={1}
          max={99}
          value={config?.keep ?? 10}
          onChange={(e) =>
            config && save({ ...config, keep: Math.max(1, Number(e.target.value) || 10) })
          }
        />
      </div>

      <div className="settings-row">
        <span className="settings-label">上次备份</span>
        <span className="settings-value">{lastText}</span>
      </div>

      <div className="settings-row">
        <span className="settings-label">操作</span>
        <div className="settings-actions">
          <button className="btn" onClick={() => void doBackup()} disabled={busy}>
            <IconRefresh width={13} height={13} />
            {busy ? "备份中…" : "立即备份"}
          </button>
          <button className="btn" onClick={() => void openFolder()}>
            打开备份文件夹
          </button>
        </div>
      </div>

      {msg && (
        <div className={`settings-message ${msgErr ? "err" : "ok"}`}>{msg}</div>
      )}

      {entries.length > 0 && (
        <div className="backup-list">
          <div className="backup-list-label">
            已有备份（{entries.length}）
          </div>
          {[...entries].reverse().map((b) => (
            <div className="backup-row" key={b.name}>
              <span className="backup-time">
                {new Date(b.timestamp * 1000).toLocaleString("zh-CN", { hour12: false })}
              </span>
              <span className="backup-size">{formatSize(b.sizeBytes)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
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
