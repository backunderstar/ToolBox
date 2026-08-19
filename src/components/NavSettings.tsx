import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  BUILTIN_GROUPS,
  type NavConfig,
  type NavItemDef,
  type NavItemMeta,
} from "../core/navPrefs";
import { normalizeNav } from "../core/navPrefs";
import { ICON_MAP, ICON_NAMES } from "./Sidebar";
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from "./icons";

interface NavSettingsProps {
  /** 归一化后的导航配置 */
  config: NavConfig;
  /** 全部导航项定义（静态 + 插件声明） */
  defs: NavItemDef[];
  onChange: (cfg: NavConfig) => void;
}

/**
 * 设置页"导航栏"卡片（全配置）：
 * - 分组管理：新建 / 重命名（自定义组）/ 删除（组内项回默认组）
 * - 项：跨组移动（拖拽 drop 或每行的「移动到…」下拉，按钮式最可靠——
 *   WebView2 里 HTML5 拖拽不稳定）+ 组内上下移 + 隐藏开关 + 编辑（标签/图标覆盖，插件项也可改）
 * - 插件项的位置完全由用户配置（默认按插件声明 group 归组，可任意移动）
 */
export function NavSettings({ config, defs, onChange }: NavSettingsProps) {
  const defById = new Map(defs.map((d) => [d.id, d]));
  const builtinIds = new Set(BUILTIN_GROUPS.map((g) => g.id));
  const [editing, setEditing] = useState<string | null>(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  /** 正在拖拽的项（视觉高亮） */
  const [drag, setDrag] = useState<{ itemId: string; from: string } | null>(null);
  /** 拖拽悬停的目标组 id（高亮） */
  const [dragOver, setDragOver] = useState<string | null>(null);
  /** 拖拽源（pointer 事件闭包用 ref 读取，避免 state 异步） */
  const dragRef = useRef<{ itemId: string; from: string } | null>(null);
  /** 拖拽期间的清理函数（pointer 监听移除），供组件卸载时兜底移除 */
  const dragCleanupRef = useRef<(() => void) | null>(null);

  /* 卸载兜底：拖拽中离开设置页时移除 window 上的 pointer 监听，避免泄漏 */
  useEffect(() => {
    return () => dragCleanupRef.current?.();
  }, []);

  const orderOf = (groupId: string): string[] => config.order[groupId] ?? [];

  /* ---- 项操作 ---- */

  const moveWithin = (groupId: string, itemId: string, dir: -1 | 1) => {
    const order = [...orderOf(groupId)];
    const idx = order.indexOf(itemId);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];
    onChange({ ...config, order: { ...config.order, [groupId]: order } });
  };

  /** 跨组移动（拖拽 drop）：从原组移除，追加到目标组末尾 */
  const moveToGroup = (itemId: string, from: string, to: string) => {
    if (from === to) return;
    const order = { ...config.order };
    order[from] = (order[from] ?? []).filter((id) => id !== itemId);
    const target = order[to] ?? [];
    if (!target.includes(itemId)) target.push(itemId);
    order[to] = target;
    onChange({ ...config, order });
  };

  /**
   * 自定义拖拽（Pointer Events）：WebView2 的 HTML5 DnD 走系统拖放协议不稳定
   * （拖动行时 drop 经常不触发），pointer 方案完全在前端可控：
   * 行上按下（避开按钮/输入框等交互元素）→ 拖动时高亮悬停的组 → 松手即跨组移动。
   */
  const startRowDrag = (e: ReactPointerEvent, itemId: string, from: string) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, input, select, textarea, label")) return;
    dragRef.current = { itemId, from };
    setDrag({ itemId, from });
    const move = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      setDragOver(el?.closest<HTMLElement>(".nav-settings-group")?.dataset.groupId ?? null);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragCleanupRef.current = null;
    };
    const up = (ev: PointerEvent) => {
      cleanup();
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const to = el?.closest<HTMLElement>(".nav-settings-group")?.dataset.groupId;
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      setDragOver(null);
      if (d && to && d.from !== to) moveToGroup(d.itemId, d.from, to);
    };
    // pointercancel（系统取消手势/窗口外松手）：只清理，不做 drop
    const cancel = () => {
      cleanup();
      dragRef.current = null;
      setDrag(null);
      setDragOver(null);
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  const toggleHidden = (itemId: string) => {
    const cur = config.meta[itemId]?.hidden;
    const meta = { ...config.meta };
    const next: NavItemMeta = { ...meta[itemId] };
    if (cur) delete next.hidden;
    else next.hidden = true;
    if (Object.keys(next).length === 0) delete meta[itemId];
    else meta[itemId] = next;
    onChange({ ...config, meta });
  };

  const saveMeta = (itemId: string, patch: NavItemMeta) => {
    const meta = { ...config.meta };
    const next: NavItemMeta = { ...meta[itemId], ...patch };
    if (Object.keys(next).length === 0) delete meta[itemId];
    else meta[itemId] = next;
    onChange({ ...config, meta });
    setEditing(null);
  };

  /* ---- 分组操作 ---- */

  const addGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const id = `user:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    onChange({
      ...config,
      groups: [...config.groups, { id, label: name }],
      order: { ...config.order, [id]: [] },
    });
    setNewGroupName("");
    setNewGroupOpen(false);
  };

  const renameGroup = (groupId: string, label: string) => {
    const t = label.trim();
    if (!t) return;
    onChange({
      ...config,
      groups: config.groups.map((g) => (g.id === groupId ? { ...g, label: t } : g)),
    });
  };

  /** 删除分组：组内项移回各自默认组，再移除组 */
  const deleteGroup = (groupId: string) => {
    const order = { ...config.order };
    const moved = order[groupId] ?? [];
    delete order[groupId];
    for (const id of moved) {
      const def = defById.get(id);
      // 注意优先级：`??` 先于 `?:`，必须用括号把三元包住，否则解析成
      // `(def?.groupId ?? builtinIds.has(groupId)) ? "work" : "system"`，
      // 只要 def 存在就恒取 "work"，把默认组为 system 的项（blog/ai）误移入 work。
      const fallback = def?.groupId ?? (builtinIds.has(groupId) ? "work" : "system");
      const list = order[fallback] ?? (order[fallback] = []);
      if (!list.includes(id)) list.push(id);
    }
    onChange({
      ...config,
      groups: config.groups.filter((g) => g.id !== groupId),
      order,
    });
  };

  const reset = () => onChange(normalizeNav(null, defs));

  /* ---- 渲染 ---- */

  return (
    <section className="settings-card">
      <h2 className="settings-title">导航栏</h2>
      <div className="settings-row">
        <span className="settings-label">说明</span>
        <span className="settings-hint">
          左侧导航完全可配置：新建/重命名分组（内置"工作区/系统"也可改名），
          按住任意项（含插件项）拖到其他分组、组内上下移调整顺序、隐藏、改名换图标；
          "设置"固定显示。插件禁用后其入口消失，恢复启用时回到你配置的位置。
        </span>
      </div>

      {config.groups.map((group) => {
        const isBuiltin = builtinIds.has(group.id);
        const items = (orderOf(group.id) ?? [])
          .map((id) => defById.get(id))
          .filter((d): d is NavItemDef => !!d);
        const isEmpty = items.length === 0;
        return (
          <div
            className={`nav-settings-group${dragOver === group.id ? " drag-over" : ""}`}
            key={group.id}
            data-group-id={group.id}
          >
            <div className="nav-settings-group-head">
              <input
                className="nav-settings-group-name"
                defaultValue={group.label}
                title={isBuiltin ? "内置分组，名称可改（插件归组不受影响）" : "分组名称"}
                onBlur={(e) => renameGroup(group.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    (e.target as HTMLInputElement).value = group.label;
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                spellCheck={false}
              />
              <span className="nav-settings-group-meta">
                {isBuiltin ? "内置" : isEmpty ? "空分组" : `${items.length} 项`}
                {!isBuiltin && (
                  <button
                    className="icon-btn sm danger"
                    title="删除分组（组内项回默认组）"
                    onClick={() => deleteGroup(group.id)}
                  >
                    <IconTrash width={12} height={12} />
                  </button>
                )}
              </span>
            </div>

            {isEmpty ? (
              <div className="nav-settings-empty">把导航项拖到这里（按住行拖动）</div>
            ) : (
              items.map((item) => {
                const meta = config.meta[item.id];
                const hidden = meta?.hidden;
                const isSettings = item.id === "settings";
                const label = meta?.label ?? item.label;
                const Icon = ICON_MAP[meta?.icon ?? item.icon] ?? ICON_MAP.grid;
                const idx = orderOf(group.id).indexOf(item.id);
                return (
                  <div
                    className={`nav-settings-row${hidden ? " hidden" : ""}${
                      drag?.itemId === item.id ? " dragging" : ""
                    }`}
                    key={item.id}
                    onPointerDown={(e) => startRowDrag(e, item.id, group.id)}
                  >
                    <span className="nav-settings-name">
                      <span className="nav-settings-icon">
                        <Icon width={13} height={13} />
                      </span>
                      <span className="nav-settings-label">
                        {label}
                        {item.fixed && <span className="nav-settings-fixed">固定</span>}
                        {hidden && <span className="nav-settings-hidden">已隐藏</span>}
                      </span>
                      <span className="nav-settings-from" title="来源">
                        {defById.get(item.id)?.groupId === group.id ? "" : "已移动"}
                      </span>
                    </span>
                    <span className="nav-settings-actions">
                      {editing === item.id ? (
                        <MetaEditor
                          initialLabel={meta?.label ?? item.label}
                          initialIcon={meta?.icon ?? item.icon}
                          onSave={(patch) => saveMeta(item.id, patch)}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <>
                          <button
                            className="icon-btn sm"
                            title="上移"
                            disabled={idx <= 0}
                            onClick={() => moveWithin(group.id, item.id, -1)}
                          >
                            <IconArrowUp width={13} height={13} />
                          </button>
                          <button
                            className="icon-btn sm"
                            title="下移"
                            disabled={idx < 0 || idx >= orderOf(group.id).length - 1}
                            onClick={() => moveWithin(group.id, item.id, 1)}
                          >
                            <IconArrowDown width={13} height={13} />
                          </button>
                          <button
                            className="icon-btn sm"
                            title="编辑标签/图标（仅本应用内显示）"
                            onClick={() => setEditing(item.id)}
                          >
                            ✎
                          </button>
                          <label
                            className={`switch${isSettings ? " disabled" : ""}`}
                            title={isSettings ? "设置固定显示" : hidden ? "点击显示" : "点击隐藏"}
                          >
                            <input
                              type="checkbox"
                              checked={!hidden}
                              disabled={isSettings}
                              aria-label={
                                isSettings
                                  ? "设置固定显示"
                                  : hidden
                                    ? `显示「${label}」`
                                    : `隐藏「${label}」`
                              }
                              onChange={() => toggleHidden(item.id)}
                            />
                            <span className="switch-track" />
                          </label>
                        </>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        );
      })}

      <div className="settings-row">
        <span className="settings-label">分组</span>
        <div className="settings-actions">
          {newGroupOpen ? (
            <span className="nav-settings-newgroup">
              <input
                className="nav-settings-newgroup-input"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addGroup();
                  if (e.key === "Escape") setNewGroupOpen(false);
                }}
                placeholder="分组名称…"
                autoFocus
                spellCheck={false}
              />
              <button className="btn btn-sm" onClick={addGroup} disabled={!newGroupName.trim()}>
                创建
              </button>
              <button className="btn btn-sm" onClick={() => setNewGroupOpen(false)}>
                取消
              </button>
            </span>
          ) : (
            <button className="btn btn-sm" onClick={() => setNewGroupOpen(true)}>
              <IconPlus width={12} height={12} />
              新建分组
            </button>
          )}
          <button className="btn btn-sm" onClick={reset}>
            恢复默认
          </button>
        </div>
      </div>
    </section>
  );
}

/** 项标签/图标编辑小表单（覆盖默认值，仅本应用内显示） */
function MetaEditor({
  initialLabel,
  initialIcon,
  onSave,
  onCancel,
}: {
  initialLabel: string;
  initialIcon: string;
  onSave: (patch: NavItemMeta) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [icon, setIcon] = useState(initialIcon);
  return (
    <span className="nav-settings-meta-editor">
      <input
        className="nav-settings-meta-label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave({ label: label.trim() || undefined, icon });
          if (e.key === "Escape") onCancel();
        }}
        placeholder="标签"
        spellCheck={false}
        autoFocus
      />
      <select
        className="nav-settings-meta-icon"
        value={icon}
        onChange={(e) => setIcon(e.target.value)}
        title="图标"
      >
        {ICON_NAMES.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <button
        className="btn btn-sm"
        onClick={() => onSave({ label: label.trim() || undefined, icon })}
      >
        保存
      </button>
      <button className="btn btn-sm" onClick={onCancel}>
        取消
      </button>
    </span>
  );
}
