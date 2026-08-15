import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../core/api";
import {
  IconChevronDown,
  IconChevronRight,
  IconFileText,
  IconFolder,
  IconTrash,
} from "./icons";

interface FileTreeProps {
  files: FileEntry[];
  activePath: string | null;
  onOpen: (rel: string) => void;
  onRemove: (rel: string) => void;
  onRename: (from: string, to: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

/** 扁平列表（目录优先、父先于子）→ 树 */
function buildTree(entries: FileEntry[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const e of entries) {
    const node: TreeNode = { name: e.name, path: e.path, isDir: e.isDir, children: [] };
    map.set(e.path, node);
    const parts = e.path.split("/");
    if (parts.length === 1) {
      roots.push(node);
    } else {
      const parent = map.get(parts.slice(0, -1).join("/"));
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh") : a.isDir ? -1 : 1
    );
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const parentOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

export function FileTree({ files, activePath, onOpen, onRemove, onRename }: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(files.filter((f) => f.isDir).map((f) => f.path))
  );

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (tree.length === 0) {
    return (
      <div className="tree-empty">
        <p>还没有笔记</p>
        <p className="tree-empty-hint">点击上方「新建笔记」开始</p>
      </div>
    );
  }

  return (
    <div className="file-tree" role="tree">
      {tree.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          activePath={activePath}
          onOpen={onOpen}
          onRemove={onRemove}
          onRename={onRename}
        />
      ))}
    </div>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  activePath: string | null;
  onOpen: (rel: string) => void;
  onRemove: (rel: string) => void;
  onRename: (from: string, to: string) => void;
}

function TreeNodeRow({
  node,
  depth,
  expanded,
  onToggle,
  activePath,
  onOpen,
  onRemove,
  onRename,
}: RowProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(node.name);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  const isOpen = expanded.has(node.path);
  const isActive = node.path === activePath;
  const indent = { paddingLeft: `${8 + depth * 14}px` };

  const commitRename = () => {
    setEditing(false);
    let name = editValue.trim();
    if (!name || name === node.name) return;
    if (!name.endsWith(".md")) name += ".md";
    const parent = parentOf(node.path);
    const to = parent ? `${parent}/${name}` : name;
    onRename(node.path, to);
  };

  /* Enter/Escape 与 onBlur 叠加：blur 在输入框卸载后也会触发，
     用 ref 标记已处理，避免 Enter 后二次提交 / Escape 无法取消 */
  const handledRef = useRef(false);

  const commitOrCancel = (cancel: boolean) => {
    if (handledRef.current) return;
    handledRef.current = true;
    if (cancel) {
      setEditing(false);
    } else {
      commitRename();
    }
  };

  const askDelete = () => {
    if (confirming) {
      onRemove(node.path);
      return;
    }
    setConfirming(true);
    confirmTimer.current = setTimeout(() => setConfirming(false), 3000);
  };

  return (
    <div>
      <div
        className={`tree-row${isActive ? " active" : ""}`}
        style={indent}
        role="treeitem"
        onClick={() => (node.isDir ? onToggle(node.path) : onOpen(node.path))}
      >
        <span className="tree-chevron">
          {node.isDir ? (
            isOpen ? <IconChevronDown width={12} height={12} /> : <IconChevronRight width={12} height={12} />
          ) : null}
        </span>
        <span className="tree-icon">
          {node.isDir ? (
            <IconFolder width={14} height={14} />
          ) : (
            <IconFileText width={14} height={14} />
          )}
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className="tree-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitOrCancel(false);
              if (e.key === "Escape") commitOrCancel(true);
            }}
            onBlur={() => commitOrCancel(handledRef.current)}
          />
        ) : (
          <span
            className="tree-name"
            title={node.path}
            onDoubleClick={(e) => {
              if (!node.isDir) {
                e.stopPropagation();
                handledRef.current = false;
                setEditValue(node.name);
                setEditing(true);
              }
            }}
          >
            {node.name}
          </span>
        )}
        {!node.isDir && !editing && (
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className={`tree-action${confirming ? " danger" : ""}`}
              title={confirming ? "再次点击确认删除" : "删除"}
              onClick={askDelete}
            >
              {confirming ? "确认?" : <IconTrash width={12} height={12} />}
            </button>
          </span>
        )}
      </div>
      {node.isDir && isOpen && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              activePath={activePath}
              onOpen={onOpen}
              onRemove={onRemove}
              onRename={onRename}
            />
          ))}
        </div>
      )}
    </div>
  );
}
