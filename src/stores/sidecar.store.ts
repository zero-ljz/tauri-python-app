import { makeAutoObservable, runInAction } from "mobx";
import { sidecarLogs, sidecarStatus, listenSidecar, listenSidecarRaw } from "@/lib/tauri-rpc";
import { rpcStore } from "@/stores/rpc.store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  LogPayload,
  SidecarReadyPayload,
  TaskProgress,
  TaskResult,
  TaskStatus,
} from "@/types/generated";

// 定义 Sidecar 连接状态类型
export type SidecarState = "unknown" | "running" | "stopped" | "error";

export interface TrackedTask {
  taskId: string;
  method: string;
  status: TaskStatus["status"];
  kind?: TaskStatus["kind"];
  cancellable?: boolean | null;
  cancelRequested: boolean;
  progress?: number | null;
  message?: string | null;
  result?: unknown;
  error?: string | null;
}

// Sidecar 进程状态 Store
class SidecarStore {
  state: SidecarState = "unknown";
  version: string | null = null;
  capabilities: string[] = [];
  tasks = new Map<string, TrackedTask>();
  lastError: string | null = null;
  private _unlisteners: UnlistenFn[] = [];

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
    // Fix 4: 不在构造函数中自动调用 _init()，避免模块加载时过早触发 Tauri IPC 调用。
    // 请在应用挂载完成后显式调用 sidecarStore.init()。
  }

  // 显式初始化入口（Fix 4）：由 main.tsx 在 React 挂载后调用
  async init(): Promise<void> {
    await this._init();
  }

  // 初始化监听以及状态轮询
  private async _init() {
    try {
      const unlisteners = await Promise.all([
        listenSidecar<SidecarReadyPayload>("sidecar.ready", this.handleReady),
        listenSidecar<{ reason?: string }>("sidecar.exited", this.handleExited),
        listenSidecar<TaskStatus>("task.status", this.handleTaskStatus),
        listenSidecar<TaskProgress>("task.progress", this.handleTaskProgress),
        listenSidecar<TaskResult>("task.result", this.handleTaskResult),
        listenSidecarRaw<LogPayload>("sidecar.log", this.handleSidecarLog),
      ]);
      runInAction(() => {
        this._unlisteners = unlisteners;
      });
      const logs = await sidecarLogs();
      runInAction(() => {
        for (const log of logs) {
          rpcStore.addSidecarLog(log);
        }
      });
    } catch (error) {
      runInAction(() => {
        this.state = "error";
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }
    
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

  private handleReady(payload: SidecarReadyPayload) {
    runInAction(() => {
      this.state = "running";
      this.version = payload.version;
      this.capabilities = payload.capabilities ?? [];
      this.lastError = null;
    });
  }

  private handleExited(payload: { reason?: string }) {
    runInAction(() => {
      this.state = "stopped";
      this.lastError = payload.reason ?? null;
      this.capabilities = [];
    });
  }

  private handleTaskStatus(payload: TaskStatus) {
    runInAction(() => {
      const existing = this.tasks.get(payload.task_id);
      this.tasks.set(payload.task_id, {
        taskId: payload.task_id,
        method: payload.method,
        status: payload.status,
        kind: payload.kind ?? existing?.kind,
        cancellable: payload.cancellable ?? existing?.cancellable,
        cancelRequested: payload.cancel_requested ?? existing?.cancelRequested ?? false,
        progress: payload.progress ?? existing?.progress,
        message: payload.message ?? existing?.message,
        result: existing?.result,
        error: existing?.error,
      });
    });
  }

  private handleTaskProgress(payload: TaskProgress) {
    runInAction(() => {
      const existing = this.tasks.get(payload.task_id);
      // task.progress 理论上晚于 task.status 到达，但极少情况下两者顺序可能颠倒。
      // 此时用合理默认值（"running" / "unknown"）暂存进度条数据，
      // 待 task.status 到达后会整体覆盖更新，属于预期的降级行为。
      this.tasks.set(payload.task_id, {
        taskId: payload.task_id,
        method: existing?.method ?? "unknown",
        status: existing?.status ?? "running",
        kind: existing?.kind,
        cancellable: existing?.cancellable,
        cancelRequested: existing?.cancelRequested ?? false,
        progress: payload.progress,
        message: payload.message ?? existing?.message,
        result: existing?.result,
        error: existing?.error,
      });
    });
  }

  private handleTaskResult(payload: TaskResult) {
    runInAction(() => {
      const existing = this.tasks.get(payload.task_id);
      this.tasks.set(payload.task_id, {
        taskId: payload.task_id,
        method: payload.method,
        status: payload.error ? "error" : "done",
        kind: existing?.kind,
        cancellable: existing?.cancellable,
        cancelRequested: existing?.cancelRequested ?? false,
        progress: payload.error ? existing?.progress : 1,
        message: existing?.message,
        result: payload.result,
        error: payload.error,
      });
    });
  }

  private handleSidecarLog(payload: LogPayload) {
    rpcStore.addSidecarLog(payload);
  }

  // 动态修改状态的方法
  setState(s: SidecarState) {
    this.state = s;
  }

  // 组件销毁或断开连接时取消监听
  dispose() {
    for (const unlisten of this._unlisteners) {
      unlisten();
    }
    this._unlisteners = [];
  }
}

export const sidecarStore = new SidecarStore();
