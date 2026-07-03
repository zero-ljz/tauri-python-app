import { makeAutoObservable, runInAction } from "mobx";
import { backendLogs, backendStatus, listenBackend, listenBackendRaw } from "@/lib/backend";
import { rpcStore } from "@/stores/rpc.store";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type {
  BackendReadyPayload,
  LogPayload,
  TaskProgress,
  TaskResult,
  TaskStatus,
} from "@/types/generated";

export type BackendState = "unknown" | "running" | "stopped" | "error";

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

class BackendStore {
  state: BackendState = "unknown";
  version: string | null = null;
  capabilities: string[] = [];
  tasks = new Map<string, TrackedTask>();
  lastError: string | null = null;
  private _unlisteners: UnlistenFn[] = [];

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  async init(): Promise<void> {
    await this._init();
  }

  private async _init() {
    try {
      const unlisteners = await Promise.all([
        listenBackend<BackendReadyPayload>("backend.ready", this.handleReady),
        listenBackend<{ reason?: string }>("backend.exited", this.handleExited),
        listenBackend<TaskStatus>("task.status", this.handleTaskStatus),
        listenBackend<TaskProgress>("task.progress", this.handleTaskProgress),
        listenBackend<TaskResult>("task.result", this.handleTaskResult),
        listenBackendRaw<LogPayload>("backend.log", this.handleBackendLog),
      ]);
      runInAction(() => {
        this._unlisteners = unlisteners;
      });

      const logs = await backendLogs();
      runInAction(() => {
        for (const log of logs) {
          rpcStore.addBackendLog(log);
        }
      });
    } catch (error) {
      runInAction(() => {
        this.state = "error";
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }

    try {
      const running = await backendStatus();
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

  private handleReady(payload: BackendReadyPayload) {
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

  private handleBackendLog(payload: LogPayload) {
    rpcStore.addBackendLog(payload);
  }

  setState(s: BackendState) {
    this.state = s;
  }

  dispose() {
    for (const unlisten of this._unlisteners) {
      unlisten();
    }
    this._unlisteners = [];
  }
}

export const backendStore = new BackendStore();
