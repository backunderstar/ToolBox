import { useCallback, useEffect, useState } from "react";
import { useVault } from "../core/vault";
import {
  historyCommit,
  historyInit,
  historyList,
  historyRollback,
  historyShow,
  historyStatus,
  type CommitInfo,
  type FileChange,
  type HistoryStatus,
} from "../core/history";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconHistory, IconRefresh } from "./icons";

/**
 * 版本历史视图：vault 内嵌 git 仓库（libgit2）。
 * - 编辑后自动提交快照（防抖 15s，Rust 后台线程）
 * - 时间线展示 + 展开看每次提交变更的文件
 * - 一键回滚到任意版本（回滚前自动保存当前状态，不丢数据）
 */
export function VersionHistoryView() {
  const vault = useVault();
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [busy, setBusy] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<CommitInfo | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const refresh = useCallback(async () => {
    if (!vault.path) return;
    try {
      const [s, l] = await Promise.all([
        historyStatus(vault.path),
        historyList(vault.path),
      ]);
      setStatus(s);
      setCommits(l);
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    }
  }, [vault.path]);

  // 挂载时加载 + 每 10s 轮询（自动提交在后台发生，状态要跟得上）
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const toggleExpand = async (c: CommitInfo) => {
    if (expanded === c.short) {
      setExpanded(null);
      setFiles([]);
      return;
    }
    setExpanded(c.short);
    if (!vault.path) return;
    try {
      setFiles(await historyShow(vault.path, c.hash));
    } catch (e) {
      setFiles([]);
      setMessage({ ok: false, text: String(e) });
    }
  };

  const doInit = async () => {
    if (!vault.path || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const s = await historyInit(vault.path);
      setStatus(s);
      await refresh();
      setMessage({ ok: true, text: "版本历史已启用：之后每次编辑都会自动保存快照" });
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const doCommit = async () => {
    if (!vault.path || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const c = await historyCommit(vault.path, "手动保存");
      await refresh();
      setMessage({ ok: true, text: c ? `已提交 ${c.short}` : "没有变更需要提交" });
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const doRollback = async () => {
    if (!vault.path || !rollbackTarget || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await historyRollback(vault.path, rollbackTarget.hash);
      await refresh();
      setMessage({
        ok: true,
        text: `已回滚到 ${rollbackTarget.short}（未提交的编辑已先保存为新版本）`,
      });
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
      setRollbackTarget(null);
    }
  };

  if (!vault.path) {
    return (
      <div className="view">
        <div className="tree-empty">
          <p>先选择工作区，再启用版本历史</p>
          <p className="tree-empty-hint">在工作区设置里选择 vault 文件夹</p>
        </div>
      </div>
    );
  }

  const last = status?.lastCommit ?? null;

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>版本历史</h1>
          <p className="view-sub">
            {status?.initialized
              ? last
                ? `最近提交 ${fmtTime(last.time)} · ${last.message}`
                : "已初始化，等待首次提交"
              : "每次编辑后自动保存快照，可随时回滚"}
          </p>
        </div>
        {status?.initialized && (
          <div className="view-actions">
            <span className={`history-pending${status.pending > 0 ? " dirty" : ""}`}>
              {status.pending > 0 ? `${status.pending} 个变更待提交` : "工作区干净"}
            </span>
            <button
              className="btn btn-sm"
              onClick={() => void refresh()}
              disabled={busy}
              title="刷新"
              aria-label="刷新"
            >
              <IconRefresh width={12} height={12} />
            </button>
            <button
              className="btn btn-sm btn-primary"
              onClick={() => void doCommit()}
              disabled={busy || status.pending === 0}
            >
              {busy ? "处理中…" : "立即提交"}
            </button>
          </div>
        )}
      </div>

      {message && (
        <p className={`settings-message ${message.ok ? "ok" : "err"}`}>
          {message.text}
        </p>
      )}

      {!status?.initialized ? (
        <div className="history-init-card">
          <IconHistory width={28} height={28} />
          <h2>为当前工作区启用版本历史</h2>
          <p>
            在你的 vault 文件夹里创建 <code>.git</code> 仓库（内嵌 git，无需安装
            git）。之后每次编辑，停止输入 15 秒后自动提交一个快照；随时可以从时间线回滚。
          </p>
          <p className="history-init-note">
            版本化的内容：笔记 / 清单 / 记录 / 项目 / 插件。
            不纳入的：<code>.toolbox/</code>（索引与备份）、<code>site/</code>（博客生成物）。
          </p>
          <button
            className="btn btn-primary"
            onClick={() => void doInit()}
            disabled={busy}
          >
            {busy ? "处理中…" : "启用版本历史"}
          </button>
        </div>
      ) : (
        <div className="history-timeline">
          {commits.length === 0 && (
            <div className="tree-empty">
              <p>还没有提交记录</p>
              <p className="tree-empty-hint">编辑笔记后会自动产生第一个快照</p>
            </div>
          )}
          {commits.map((c) => (
            <div
              key={c.hash}
              className={`history-commit${expanded === c.short ? " open" : ""}`}
            >
              <button
                className="history-commit-head"
                onClick={() => void toggleExpand(c)}
                aria-expanded={expanded === c.short}
              >
                <span className="history-dot" aria-hidden="true" />
                <span className="history-time">{fmtTime(c.time)}</span>
                <span className="history-msg">{c.message}</span>
                <span className="history-files">{c.files} 个文件</span>
                <span className="history-hash">{c.short}</span>
              </button>
              {expanded === c.short && (
                <div className="history-commit-body">
                  <ul className="history-files-list">
                    {files.length === 0 && <li className="history-file-empty">加载中…</li>}
                    {files.map((f) => (
                      <li key={f.path}>
                        <span className={`history-status s-${f.status.toLowerCase()}`}>
                          {f.status}
                        </span>
                        <span className="history-file-path">{f.path}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="history-commit-actions">
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => setRollbackTarget(c)}
                      disabled={busy}
                    >
                      回滚到此版本
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!rollbackTarget}
        title="回滚到该版本？"
        message={
          rollbackTarget
            ? `工作区中的笔记、清单、记录、项目、插件将恢复到 ${rollbackTarget.short}（${fmtTime(rollbackTarget.time)}）的状态。\n回滚前会先把当前未提交的编辑保存为新版本，不会丢失。未跟踪的新文件也会保留。`
            : ""
        }
        confirmText="回滚"
        danger
        onConfirm={() => void doRollback()}
        onCancel={() => setRollbackTarget(null)}
      />
    </div>
  );
}

function fmtTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
