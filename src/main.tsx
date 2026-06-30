import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Initialize stores (side effects on import)
import "./stores/app.store";
import "./stores/rpc.store";

// Fix 4: sidecarStore 不在模块加载时自动 init，避免 Tauri IPC 尚未就绪时触发调用
import { sidecarStore } from "./stores/sidecar.store";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Fix 4: 在 React 渲染完成后显式初始化 Sidecar Store，此时 Tauri IPC bridge 已就绪
void sidecarStore.init();
