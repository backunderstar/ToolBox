import type { NavPrefs } from "../core/navPrefs";
import { normalizeNavPrefs } from "../core/navPrefs";
import { NAV_GROUPS } from "./Sidebar";
import { IconArrowDown, IconArrowUp } from "./icons";

interface NavSettingsProps {
  prefs: NavPrefs;
  onChange: (prefs: NavPrefs) => void;
}

/**
 * 设置页"导航栏"卡片：调整侧边栏导航项的顺序与显示/隐藏。
 * - 顺序：组内上移/下移（settings 固定可见，其余可隐藏）
 * - 所有项在设置里始终可见（含已隐藏的），便于随时恢复
 */
export function NavSettings({ prefs, onChange }: NavSettingsProps) {
  /** 取某分组的当前顺序（含用户调整），缺失时用默认 */
  const orderOf = (groupLabel: string): string[] =>
    prefs.order[groupLabel] ??
    NAV_GROUPS.find((g) => g.label === groupLabel)!.items.map((i) => i.id);

  const move = (groupLabel: string, id: string, dir: -1 | 1) => {
    const order = [...orderOf(groupLabel)];
    const idx = order.indexOf(id);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];
    onChange({ ...prefs, order: { ...prefs.order, [groupLabel]: order } });
  };

  const toggleHidden = (id: string) => {
    const hidden = prefs.hidden.includes(id)
      ? prefs.hidden.filter((h) => h !== id)
      : [...prefs.hidden, id];
    onChange({ ...prefs, hidden });
  };

  const reset = () => onChange(normalizeNavPrefs(NAV_GROUPS, null));

  return (
    <section className="settings-card">
      <h2 className="settings-title">导航栏</h2>
      <div className="settings-row">
        <span className="settings-label">说明</span>
        <span className="settings-hint">
          调整左侧导航的顺序与显隐；"设置"固定显示（保证随时能回到这里）
        </span>
      </div>

      {NAV_GROUPS.map((group) => {
        const order = orderOf(group.label);
        return (
          <div className="nav-settings-group" key={group.label}>
            <div className="nav-settings-group-label">{group.label}</div>
            {group.items.map((item) => {
              const idx = order.indexOf(item.id);
              const isSettings = item.id === "settings";
              const hidden = prefs.hidden.includes(item.id);
              return (
                <div
                  className={`nav-settings-row${hidden ? " hidden" : ""}`}
                  key={item.id}
                >
                  <span className="nav-settings-name">
                    {item.label}
                    {isSettings && (
                      <span className="nav-settings-fixed">固定</span>
                    )}
                    {hidden && <span className="nav-settings-hidden">已隐藏</span>}
                  </span>
                  <span className="nav-settings-actions">
                    <button
                      className="icon-btn sm"
                      title="上移"
                      disabled={idx <= 0}
                      onClick={() => move(group.label, item.id, -1)}
                    >
                      <IconArrowUp width={13} height={13} />
                    </button>
                    <button
                      className="icon-btn sm"
                      title="下移"
                      disabled={idx < 0 || idx >= order.length - 1}
                      onClick={() => move(group.label, item.id, 1)}
                    >
                      <IconArrowDown width={13} height={13} />
                    </button>
                    <label
                      className={`switch${hidden ? " off" : ""}${
                        isSettings ? " disabled" : ""
                      }`}
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
                              ? `显示「${item.label}」`
                              : `隐藏「${item.label}」`
                        }
                        onChange={() => toggleHidden(item.id)}
                      />
                      <span className="switch-track" />
                    </label>
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}

      <div className="settings-row">
        <span className="settings-label">操作</span>
        <div className="settings-actions">
          <button className="btn btn-sm" onClick={reset}>
            恢复默认顺序与显隐
          </button>
        </div>
      </div>
    </section>
  );
}
