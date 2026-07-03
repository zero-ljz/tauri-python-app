import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Initialize stores (side effects on import)
import "./stores/app.store";
import "./stores/rpc.store";

import { backendStore } from "./stores/backend.store";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

void backendStore.init();
