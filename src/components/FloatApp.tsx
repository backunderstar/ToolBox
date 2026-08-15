import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  vaultGet,
  todosAdd,
  todosClearDone,
  todosDelete,
  todosList,
  todosToggle,
  floatSetLocked,
} from "../core/api";
import type { TodosItem } from "../core/api";
import { IconLock } from "./icons";
import "./float.css";

const LOCK_KEY = "toolbox.float.locked";

/**
 * 桌面半透明浮窗（快速待办）：
 * - 独立窗口（transparent + 无边框 + 桌面层不置顶），加载同一前端入口，按窗口 label 分流到这里
 * - 数据 = vault/data/todos/todos.json（与主应用同源，事件同步）
 * - 深色半透明卡片样式，不跟随主应用主题
 * - 无最小化/隐藏按钮（桌面小组件常驻，显隐由主窗口顶栏/托盘控制）
 * - 可锁定位置：锁定时禁用拖拽与调整大小（防误拖）
 */
export function FloatApp() {
  const [items, setItems] = useState<TodosItem[]>([]);
  const [text, setText] = useState("");
  const [ready, setReady] = useState(false);
  const [vaultMissing, setVaultMissing] = useState(false);
  const [locked, setLocked] = useState(() => {
    try {
      return localStorage.getItem(LOCK_KEY) === "1";
    } catch {
      return false;
    }
  });
  const inputRef = useRef<HTMLInputElement | null>(null);

  /* 浮窗模式：body 背景透明（窗口自身 transparent，露出圆角外区域） */
  useEffect(() => {
    document.body.classList.add("float-mode");
    return () => document.body.classList.remove("float-mode");
  }, []);

  /* 初始同步锁定状态到 Rust（浮窗重建后恢复 set_resizable） */
  useEffect(() => {
    void floatSetLocked(locked).catch(() => undefined);
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
    void floatSetLocked(next).catch(() => undefined);
  };

  /* 加载数据 + 订阅变更事件（主窗口/浮窗任意改动都刷新） */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await vaultGet();
        if (!s.path) {
          setVaultMissing(true);
          setReady(true);
          return;
        }
        if (!alive) return;
        setItems(await todosList());
        setVaultMissing(false);
      } catch {
        setVaultMissing(true);
      } finally {
        if (alive) setReady(true);
      }
    })();
    const un = listen("todos-changed", () => {
      void todosList()
        .then(setItems)
        .catch(() => undefined);
    });
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    try {
      setItems(await todosAdd(t));
    } catch {
      /* 忽略 */
    }
    inputRef.current?.focus();
  };

  const toggle = async (id: string) => {
    try {
      setItems(await todosToggle(id));
    } catch {
      /* 忽略 */
    }
  };

  const remove = async (id: string) => {
    try {
      setItems(await todosDelete(id));
    } catch {
      /* 忽略 */
    }
  };

  const clearDone = async () => {
    try {
      setItems(await todosClearDone());
    } catch {
      /* 忽略 */
    }
  };

  const doneCount = items.filter((i) => i.done).length;

  /* 锁定后禁用拖拽：不给标题栏加 data-tauri-drag-region */
  const dragProps = locked ? {} : { "data-tauri-drag-region": true };
  return (
    <div className="float-window">
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
          onClick={toggleLock}
        >
          <IconLock width={11} height={11} />
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
      <div className="float-list">
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
                onClick={() => void toggle(it.id)}
              >
                {it.done && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 12.5l5 5L20 6.5" />
                  </svg>
                )}
              </button>
              <span className="float-item-text">{it.text}</span>
              <button className="float-del" title="删除" onClick={() => void remove(it.id)}>
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
