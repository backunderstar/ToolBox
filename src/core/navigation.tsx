import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { ViewId } from "../components/Sidebar";

/**
 * 跨视图导航：视图切换 + 打开具体条目（笔记/清单/记录）。
 * 值由 AppInner 用 useMemo 构造，这里只定义 context 形状。
 */

export interface ViewParams {
  /** 跳转到清单视图并打开指定清单 */
  openChecklistId?: string;
  /** 跳转到记录视图并打开指定记录 */
  openRecordId?: string;
}

export interface NavContextValue {
  view: ViewId;
  params: ViewParams;
  go: (view: ViewId, params?: ViewParams) => void;
  /** 打开笔记（切到笔记视图并打开文件） */
  openNote: (rel: string) => void;
  /** 打开清单（切到清单视图并加载） */
  openChecklist: (id: string) => void;
  /** 打开记录（切到记录视图并加载） */
  openRecord: (id: string) => void;
}

const NavContext = createContext<NavContextValue | null>(null);

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("useNav 必须在 NavProvider 内使用");
  return ctx;
}

export function NavProvider({
  value,
  children,
}: {
  value: NavContextValue;
  children: ReactNode;
}) {
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}
