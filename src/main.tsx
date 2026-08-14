import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyTheme, getInitialTheme } from "./themes/theme";

// 渲染前应用初始主题，避免首帧亮/暗闪烁（含原生标题栏同步）
applyTheme(getInitialTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
