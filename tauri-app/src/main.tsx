import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "highlight.js/styles/atom-one-dark.css";

// StrictMode 已恢复：初始化 listener 的双注册问题已通过 cancelled flag 修复
// （见 App.tsx 初始化 useEffect 的注释），不再需要禁用 StrictMode 来规避。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
