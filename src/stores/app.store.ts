import { makeAutoObservable } from "mobx";

export type Theme = "light" | "dark" | "system";

// 全局应用状态 Store
class AppStore {
  theme: Theme = "system"; // 主题配置：light/dark/system
  preferencesOpen = false; // 偏好设置弹窗控制
  debugPanelOpen = false;  // 调试面板显示控制
  private _systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

  constructor() {
    makeAutoObservable(this);
    this._loadTheme();
    this._systemThemeQuery.addEventListener("change", () => {
      if (this.theme === "system") {
        this._applyTheme();
      }
    });
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
    let resolvedTheme: "dark" | "light";

    if (this.theme === "dark") {
      resolvedTheme = "dark";
    } else if (this.theme === "light") {
      resolvedTheme = "light";
    } else {
      // 如果是跟随系统，判断系统的深浅色模式
      resolvedTheme = this._systemThemeQuery.matches ? "dark" : "light";
    }

    root.classList.add(resolvedTheme);
    root.style.colorScheme = resolvedTheme;
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
