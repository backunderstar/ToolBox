import type { PingInfo } from "../core/ipc";
import type { ThemeMode } from "../themes/theme";

interface StatusBarProps {
  ping: PingInfo | null;
  theme: ThemeMode;
  vaultName: string | null;
  status: string;
}

export function StatusBar({ ping, theme, vaultName, status }: StatusBarProps) {
  const ok = ping?.message === "pong";
  const label = ping ? ping.message : "连接中…";

  return (
    <footer className="statusbar">
      <span
        className={`status-dot${ok ? "" : " warn"}`}
        title={ok ? "IPC 链路正常" : "未连接 Tauri 核心（浏览器预览）"}
      />
      <span>IPC {label}</span>
      <span className="status-msg" title={status}>
        {status}
      </span>
      <div className="spacer" />
      <span>主题 {theme === "light" ? "亮色" : "暗色"}</span>
      <span>工作区 {vaultName ?? "未选择"}</span>
      <span>核心 v{ping?.coreVersion ?? "…"}</span>
    </footer>
  );
}
