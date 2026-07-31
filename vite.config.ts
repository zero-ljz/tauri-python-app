import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";

const host = process.env.TAURI_DEV_HOST || "127.0.0.1";

export default defineConfig(() => ({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      // 配置路径别名，方便前端导入组件
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // 避免 Vite 监听 Rust 源码目录，导致不必要的重启
      ignored: ["**/src-tauri/**"],
    },
  },
}));
