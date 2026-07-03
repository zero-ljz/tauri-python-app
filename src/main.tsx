import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./index.css";

// Initialize stores (side effects on import)
import "./stores/app.store";
import "./stores/rpc.store";

import { backendStore } from "./stores/backend.store";

let didBootstrap = false;

async function showMainWindow() {
  try {
    const window = getCurrentWindow();
    await window.show();
    await window.setFocus();
  } catch (error) {
    console.warn("Failed to show main window", error);
  }
}

function Root() {
  React.useEffect(() => {
    if (didBootstrap) {
      return;
    }
    didBootstrap = true;

    void showMainWindow();
    setTimeout(() => {
      void backendStore.init();
    }, 0);
  }, []);

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
