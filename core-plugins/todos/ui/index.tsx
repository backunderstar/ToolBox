// core-todos 插件自带前端（浮窗快速待办）。
// 宿主 FloatApp 只保留窗口外壳（float-mode body、透明窗口、加载器），
// 本组件负责整个浮窗内容：标题栏（拖拽区 + 位置锁定）、输入行、待办列表、清除已完成。
// 复用宿主全局 .float-* class（float.css 打进宿主 bundle，同 document 生效）；
// data-tauri-drag-region 属性在任意元素上生效（锁定时移除禁用拖拽）。
import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

/** 宿主注入的桥 API（FloatApp 构造：统一桥 + floatSetLocked 宿主命令） */
interface PluginBridgeApi {
  pluginId: string;
  call: (command: string, args?: unknown, targetPluginId?: string) => Promise<unknown>;
  on: (event: string, cb: (data: unknown) => void, targetPluginId?: string) => () => void;
  context: { vault: string | null } & Record<string, unknown>;
  /** 锁定 / 解锁浮窗位置（宿主窗口命令，锁定时禁用拖拽与调整大小） */
  floatSetLocked: (locked: boolean) => Promise<void>;
}

interface TodosItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: string;
}

const LOCK_KEY = "toolbox.float.locked";

export function TodosPluginUi({ api }: { api: PluginBridgeApi }) {
  const [items, setItems] = useState<TodosItem[]>([]);
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const vaultMissing = !api.context.vault;
  const [locked, setLocked] = useState(() => {
    try {
      return localStorage.getItem(LOCK_KEY) === "1";
    } catch {
      return false;
    }
  });
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* 初始同步锁定状态到 Rust（浮窗重建后恢复 set_resizable） */
  useEffect(() => {
    void api.floatSetLocked(locked).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    try {
      localStorage.setItem(LOCK_KEY, next ? "1" : "0");
    } catch {
      /* 忽略 */
    }
    void api.floatSetLocked(next).catch(() => undefined);
  };

  /* 加载数据 + 订阅变更事件（主窗口/浮窗任意改动都刷新） */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!api.context.vault) {
          setReady(true);
          return;
        }
        if (!alive) return;
        setItems((await api.call("todos.list")) as TodosItem[]);
      } catch {
        /* 读取失败保持空列表 */
      } finally {
        if (alive) setReady(true);
      }
    })();
    const un = api.on("todos-changed", () => {
      if (!api.context.vault) return;
      api
        .call("todos.list")
        .then((v) => setItems(v as TodosItem[]))
        .catch(() => undefined);
    });
    return () => {
      alive = false;
      un();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    try {
      setItems((await api.call("todos.add", { text: t })) as TodosItem[]);
    } catch {
      /* 忽略 */
    }
    inputRef.current?.focus();
  };

  const toggle = async (id: string) => {
    try {
      setItems((await api.call("todos.toggle", { id })) as TodosItem[]);
    } catch {
      /* 忽略 */
    }
  };

  const remove = async (id: string) => {
    try {
      setItems((await api.call("todos.delete", { id })) as TodosItem[]);
    } catch {
      /* 忽略 */
    }
  };

  const clearDone = async () => {
    try {
      setItems((await api.call("todos.clearDone")) as TodosItem[]);
    } catch {
      /* 忽略 */
    }
  };

  const doneCount = items.filter((i) => i.done).length;

  /* 锁定后禁用拖拽：不给标题栏加 data-tauri-drag-region */
  const dragProps = locked ? {} : { "data-tauri-drag-region": true };
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* 自绘标题栏：拖拽区域（data-tauri-drag-region，锁定时禁用）+ 位置锁定 */}
      <div className="float-titlebar" {...dragProps}>
        <span className="float-title" {...dragProps}>
          快速待办
        </span>
        <span className="float-count" {...dragProps}>
          {doneCount}/{items.length}
        </span>
        <button
          className={`float-lock${locked ? " on" : ""}`}
          title={locked ? "已锁定位置 —— 点击解锁（可拖拽/调整大小）" : "锁定位置（防误拖）"}
          aria-label={locked ? "解锁位置" : "锁定位置"}
          aria-pressed={locked}
          onClick={toggleLock}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </button>
      </div>

      {/* 输入行 */}
      <div className="float-input-row">
        <input
          ref={inputRef}
          className="float-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder={vaultMissing ? "未选择工作区" : "添加待办，回车确认…"}
          disabled={vaultMissing}
          spellCheck={false}
        />
        <button className="float-add" onClick={() => void add()} disabled={!text.trim() || vaultMissing} title="添加">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {/* 待办列表 */}
      <div className="float-list" aria-live="polite">
        {!ready ? (
          <div className="float-empty">加载中…</div>
        ) : vaultMissing ? (
          <div className="float-empty">请先在主窗口选择一个工作区</div>
        ) : items.length === 0 ? (
          <div className="float-empty">暂无待办 —— 上面输入即可添加</div>
        ) : (
          items.map((it) => (
            <div key={it.id} className={`float-item${it.done ? " done" : ""}`}>
              <button
                className={`float-check${it.done ? " on" : ""}`}
                title={it.done ? "标记未完成" : "标记完成"}
                aria-label={it.done ? `标记未完成：${it.text}` : `标记完成：${it.text}`}
                onClick={() => void toggle(it.id)}
              >
                {it.done && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12.5l5 5L20 6.5" />
                  </svg>
                )}
              </button>
              <span className="float-item-text">{it.text}</span>
              <button
                className="float-del"
                title="删除"
                aria-label={`删除待办：${it.text}`}
                onClick={() => void remove(it.id)}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>

      {/* 底部：清除已完成 */}
      {items.length > 0 && (
        <div className="float-foot">
          <button className="float-clear" onClick={() => void clearDone()} disabled={doneCount === 0}>
            清除已完成（{doneCount}）
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- 注册到全局（宿主 FloatApp 注入后读取） ---- */
declare global {
  interface Window {
    __TB_PLUGIN_UI__?: Record<
      string,
      { mount: (el: HTMLElement, api: PluginBridgeApi) => void; unmount?: () => void }
    >;
  }
}

let root: Root | null = null;
window.__TB_PLUGIN_UI__ = window.__TB_PLUGIN_UI__ || {};
window.__TB_PLUGIN_UI__["core-todos"] = {
  mount(el, api) {
    root = createRoot(el);
    root.render(<TodosPluginUi api={api} />);
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
