import { makeAutoObservable, runInAction } from "mobx";
import { backendLogs, backendStart, backendStatus, rpc } from "@/lib/rpc";
import { rpcStore } from "@/stores/rpc.store";
import type {
  BackendReadyPayload,
  LogPayload,
  TaskProgress,
  TaskResult,
  TaskStatus,
} from "@/types/generated";

export type BackendState =
  | "unknown"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

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
  private readonly maxTasks = 500;
  state: BackendState = "unknown";
  version: string | null = null;
  capabilities: string[] = [];
  tasks = new Map<string, TrackedTask>();
  lastError: string | null = null;
  private _offHandlers: Array<() => void> = [];
  private _listeners: string[] = [];
  private _restartAttempts = 0;
  private _restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  async init(): Promise<void> {
    await this._init();
  }

  private async _init() {
    const trackedEvents = [
      "backend.ready",
      "backend.exited",
      "task.status",
      "task.progress",
      "task.result",
    ];
    const rawEvents = ["backend.log"];
    const offHandlers = [
      rpc.on<BackendReadyPayload>("backend.ready", this.handleReady),
      rpc.on<{ reason?: string; recoverable?: boolean }>("backend.exited", this.handleExited),
      rpc.on<TaskStatus>("task.status", this.handleTaskStatus),
      rpc.on<TaskProgress>("task.progress", this.handleTaskProgress),
      rpc.on<TaskResult>("task.result", this.handleTaskResult),
      rpc.on<LogPayload>("backend.log", this.handleBackendLog),
    ];

    try {
      await Promise.all([
        rpc.listen(trackedEvents),
        rpc.listen(rawEvents, { track: false }),
      ]);
      runInAction(() => {
        this._offHandlers = offHandlers;
        this._listeners = [...trackedEvents, ...rawEvents];
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
      for (const off of offHandlers) {
        off();
      }
      await Promise.allSettled(
        [...trackedEvents, ...rawEvents].map((event) => rpc.unlisten(event))
      );
    }

    try {
      const status = await backendStatus();
      runInAction(() => {
        this.state =
          status.phase === "ready"
            ? "running"
            : status.phase === "starting"
              ? "starting"
              : status.phase === "stopping"
                ? "stopping"
                : status.phase === "failed"
                  ? "error"
                  : "stopped";
        this.version = status.version;
        this.capabilities = status.capabilities;
        this.lastError = status.last_error;
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
      this._restartAttempts = 0;
      if (this._restartTimer !== null) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
    });
  }

  private handleExited(payload: { reason?: string; recoverable?: boolean }) {
    runInAction(() => {
      this.state = "stopped";
      this.lastError = payload.reason ?? null;
      this.capabilities = [];
    });
    if (payload.recoverable) {
      this.scheduleRestart();
    }
  }

  private scheduleRestart() {
    if (this._restartAttempts >= 3 || this._restartTimer !== null) return;
    const delay = 500 * 2 ** this._restartAttempts;
    this._restartAttempts += 1;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      runInAction(() => {
        this.state = "starting";
      });
      void backendStart().catch((error) => {
        runInAction(() => {
          this.state = "error";
          this.lastError = error instanceof Error ? error.message : String(error);
        });
        this.scheduleRestart();
      });
    }, delay);
  }

  private handleTaskStatus(payload: TaskStatus) {
    runInAction(() => {
      const existing = this.tasks.get(payload.task_id);
      this.setTrackedTask(payload.task_id, {
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
      this.setTrackedTask(payload.task_id, {
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
      this.setTrackedTask(payload.task_id, {
        taskId: payload.task_id,
        method: payload.method,
        status: payload.error != null ? "error" : "done",
        kind: existing?.kind,
        cancellable: existing?.cancellable,
        cancelRequested: existing?.cancelRequested ?? false,
        progress: payload.error != null ? existing?.progress : 1,
        message: existing?.message,
        result: payload.result,
        error: payload.error,
      });
    });
  }

  private handleBackendLog(payload: LogPayload) {
    rpcStore.addBackendLog(payload);
  }

  private setTrackedTask(taskId: string, task: TrackedTask) {
    // Refresh insertion order on update, then evict the oldest completed/history
    // entries so a long-running desktop session has bounded memory usage.
    this.tasks.delete(taskId);
    this.tasks.set(taskId, task);
    while (this.tasks.size > this.maxTasks) {
      const oldest = this.tasks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tasks.delete(oldest);
    }
  }

  setState(s: BackendState) {
    this.state = s;
  }

  dispose() {
    if (this._restartTimer !== null) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    for (const off of this._offHandlers) {
      off();
    }
    for (const event of this._listeners) {
      void rpc.unlisten(event);
    }
    this._offHandlers = [];
    this._listeners = [];
  }
}

export const backendStore = new BackendStore();
