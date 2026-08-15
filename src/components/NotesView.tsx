import type { ReactNode } from "react";
import { useVault } from "../core/vault";
import type { SearchHit } from "../core/api";
import { Editor } from "./Editor";
import { FileTree } from "./FileTree";
import { Backlinks } from "./Backlinks";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExpand,
  IconFileText,
  IconFolder,
  IconPlus,
  IconShrink,
} from "./icons";

interface NotesViewProps {
  dark: boolean;
  filesCollapsed: boolean;
  focusMode: boolean;
  onToggleFiles: () => void;
  onToggleFocus: () => void;
}

export function NotesView({
  dark,
  filesCollapsed,
  focusMode,
  onToggleFiles,
  onToggleFocus,
}: NotesViewProps) {
  const vault = useVault();
  const {
    path,
    files,
    activePath,
    content,
    dirty,
    recent,
    query,
    results,
    searching,
    pickVault,
    openFile,
    save,
    newNote,
    removeFile,
    renameFile,
    setQuery,
    updateContent,
  } = vault;

  const vaultName = path ? path.split(/[\\/]/).pop() ?? path : null;

  /* 无工作区：引导选择文件夹 */
  if (!path) {
    return (
      <div className="empty-state fade-in">
        <div className="empty-icon">
          <IconFolder width={28} height={28} />
        </div>
        <h2>选择工作区文件夹</h2>
        <p>
          笔记以普通 Markdown 文件存放在你指定的文件夹中，
          数据始终是你的，随时可迁移、可备份。
        </p>
        <button className="btn-primary" onClick={pickVault}>
          选择文件夹…
        </button>
      </div>
    );
  }

  const showingSearch = query.trim().length > 0;

  return (
    <div className="notes">
      {/* 文件侧栏（专注模式或折叠时隐藏/收窄） */}
      {!focusMode &&
        (filesCollapsed ? (
          <aside className="files-pane collapsed">
            <button
              className="files-expand"
              onClick={onToggleFiles}
              title="展开文件面板"
            >
              <IconChevronRight width={16} height={16} />
            </button>
          </aside>
        ) : (
          <aside className="files-pane">
            <div className="files-header">
              <span className="files-title" title={path}>
                {vaultName}
              </span>
              <button className="icon-btn sm" title="新建笔记" onClick={newNote}>
                <IconPlus width={14} height={14} />
              </button>
              <button
                className="icon-btn sm"
                title="收起文件面板"
                onClick={onToggleFiles}
              >
                <IconChevronLeft width={14} height={14} />
              </button>
            </div>

            {recent.length > 0 && (
              <div className="recent-block">
                <div className="recent-label">最近打开</div>
                {recent.slice(0, 5).map((r) => (
                  <button
                    key={r}
                    className="recent-item"
                    title={r}
                    onClick={() => openFile(r)}
                  >
                    <IconFileText width={12} height={12} />
                    <span>{r.split("/").pop()}</span>
                  </button>
                ))}
              </div>
            )}

            <FileTree
              files={files}
              activePath={activePath}
              onOpen={openFile}
              onRemove={removeFile}
              onRename={renameFile}
            />
          </aside>
        ))}

      {/* 编辑器区域 */}
      <div className="editor-area">
        {showingSearch ? (
          <SearchResults
            searching={searching}
            results={results}
            query={query}
            onOpen={(rel) => {
              openFile(rel);
              setQuery("");
            }}
          />
        ) : activePath ? (
          <>
            <div className="editor-header">
              <span className={`dirty-dot${dirty ? " on" : ""}`} title={dirty ? "有未保存修改" : "已保存"} />
              <span className="editor-title" title={activePath}>
                {activePath}
              </span>
              <div className="spacer" />
              <button
                className="icon-btn sm"
                onClick={onToggleFocus}
                title={focusMode ? "退出专注模式" : "专注模式（隐藏侧栏，全屏书写）"}
              >
                {focusMode ? (
                  <IconShrink width={14} height={14} />
                ) : (
                  <IconExpand width={14} height={14} />
                )}
              </button>
              <button className="btn-ghost sm" onClick={() => save(true)}>
                {dirty ? "保存" : "已保存"}
              </button>
            </div>
            <Backlinks activePath={activePath} />
            <div className="editor-body">
              <Editor
                key={`${activePath}|${dark}`}
                doc={content}
                onChange={updateContent}
                onSave={() => save(true)}
                dark={dark}
                placeholderText="开始书写…"
              />
            </div>
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">
              <IconFileText width={28} height={28} />
            </div>
            <h2>从一篇笔记开始</h2>
            <p>在左侧选择一篇笔记，或新建一篇。</p>
            <button className="btn-primary" onClick={newNote}>
              新建笔记
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SearchResults({
  searching,
  results,
  query,
  onOpen,
}: {
  searching: boolean;
  results: SearchHit[] | null;
  query: string;
  onOpen: (rel: string) => void;
}) {
  const count = results?.length ?? 0;
  return (
    <div className="search-results">
      <div className="search-results-header">
        <span>
          搜索「{query}」{searching ? "…" : ` · ${count} 个结果`}
        </span>
      </div>
      {searching ? (
        <div className="search-hint">检索中…</div>
      ) : count === 0 ? (
        <div className="search-hint">没有匹配的笔记</div>
      ) : (
        <div className="search-list">
          {results!.map((hit) => (
            <button
              key={hit.path}
              className="result-item"
              onClick={() => onOpen(hit.path)}
            >
              <div className="result-title">
                {highlight(hit.path, query)}
              </div>
              <div className="result-snippet">
                {highlight(hit.snippet, query)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 大小写不敏感的关键词高亮（安全转义正则） */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  const lower = query.toLowerCase();
  return parts.map((part, i) =>
    part.toLowerCase() === lower ? <mark key={i}>{part}</mark> : part
  );
}
