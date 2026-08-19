import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { ViewId } from "../components/Sidebar";

/**
 * 跨视图导航：视图切换 + 打开具体条目（笔记/清单）。
 * 值由 AppInner 用 useMemo 构造，这里只定义 context 形状。
 */

export interface NavContextValue {
  view: ViewId;
  go: (view: ViewId) => void;
  /** 打开笔记（切到笔记视图并打开文件） */
  openNote: (rel: string) => void;
  /** 打开清单（切到清单视图；具体清单 id 经 tb:open-checklist 事件广播，宿主不持有） */
  openChecklist: () => void;
}

const NavContext = createContext<NavContextValue | null>(null);

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav 必须在 NavProvider 内使用");
  return ctx;
}

export function NavProvider({ value, children }: { value: NavContextValue; children: ReactNode }) {
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
