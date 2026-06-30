import { makeAutoObservable } from "mobx";

export type Theme = "light" | "dark" | "system";

// 全局应用状态 Store
class AppStore {
  theme: Theme = "system"; // 主题配置：light/dark/system
  preferencesOpen = false; // 偏好设置弹窗控制
  debugPanelOpen = false;  // 调试面板显示控制

  constructor() {
    makeAutoObservable(this);
    this._loadTheme();
  }

  // 从本地存储加载并应用主题
  private _loadTheme() {
    const saved = localStorage.getItem("theme") as Theme | null;
    if (saved) this.theme = saved;
    this._applyTheme();
  }

  // 切换主题方法
  setTheme(theme: Theme) {
    this.theme = theme;
    localStorage.setItem("theme", theme);
    this._applyTheme();
  }

  // 将主题 class 应用到 HTML 根节点上
  private _applyTheme() {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    if (this.theme === "dark") {
      root.classList.add("dark");
    } else if (this.theme === "light") {
      root.classList.add("light");
    } else {
      // 如果是跟随系统，判断系统的深浅色模式
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.classList.add(prefersDark ? "dark" : "light");
    }
  }

  // 打开偏好设置
  openPreferences() {
    this.preferencesOpen = true;
  }

  // 关闭偏好设置
  closePreferences() {
    this.preferencesOpen = false;
  }

  // 切换调试面板显示状态
  toggleDebugPanel() {
    this.debugPanelOpen = !this.debugPanelOpen;
  }
}

export const appStore = new AppStore();
