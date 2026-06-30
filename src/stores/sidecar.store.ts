import { makeAutoObservable, runInAction } from "mobx";
import { sidecarStatus, listenSidecar } from "@/lib/tauri-rpc";
import type { UnlistenFn } from "@tauri-apps/api/event";

// 定义 Sidecar 连接状态类型
export type SidecarState = "unknown" | "running" | "stopped" | "error";

// Sidecar 进程状态 Store
class SidecarStore {
  state: SidecarState = "unknown";
  private _unlisten: UnlistenFn | null = null;

  constructor() {
    makeAutoObservable(this);
    this._init();
  }

  // 初始化监听以及状态轮询
  private async _init() {
    // 监听 Python 端发送的 sidecar.ready 就绪事件
    this._unlisten = await listenSidecar("sidecar.ready", () => {
      runInAction(() => {
        this.state = "running";
      });
    });
    
    // 轮询检查进程状态
    try {
      const running = await sidecarStatus();
      runInAction(() => {
        if (this.state === "unknown") {
          this.state = running ? "running" : "stopped";
        }
      });
    } catch {
      runInAction(() => {
        this.state = "error";
      });
    }
  }

  // 动态修改状态的方法
  setState(s: SidecarState) {
    this.state = s;
  }

  // 组件销毁或断开连接时取消监听
  dispose() {
    this._unlisten?.();
  }
}

export const sidecarStore = new SidecarStore();
