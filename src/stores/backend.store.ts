import { makeAutoObservable, runInAction } from "mobx";
import { backendLogs, backendStart, backendStatus, rpc } from "@/lib/rpc";
import { rpcStore } from "@/stores/rpc.store";
import type {
  BackendReadyPayload,
  LogPayload,
  TaskProgress,
  TaskSnapshot,
} from "@/types/generated";
import { MAX_TASK_HISTORY } from "@/types/protocol";

export type BackendState = "unknown" | "starting" | "running" | "stopping" | "stopped" | "error";

export interface TrackedTask {
  taskId: string;
  method: string;
  status: TaskSnapshot["status"];
  kind?: TaskSnapshot["kind"];
  cancellable?: boolean | null;
  cancelRequested: boolean;
  progress?: number | null;
  message?: string | null;
  result?: unknown;
  error?: string | null;
}

export class BackendStore {
  private readonly maxTasks = MAX_TASK_HISTORY;
  state: BackendState = "unknown";
  version: string | null = null;
  capabilities: string[] = [];
  methodPermissions: Record<string, string> = {};
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
    const trackedEvents = ["backend.ready", "backend.exited", "task.updated", "task.progress"];
    const rawEvents = ["backend.log"];
    const offHandlers = [
      rpc.on<BackendReadyPayload>("backend.ready", this.handleReady),
      rpc.on<{ reason?: string; recoverable?: boolean }>("backend.exited", this.handleExited),
      rpc.on<TaskSnapshot>("task.updated", this.handleTaskUpdated),
      rpc.on<TaskProgress>("task.progress", this.handleTaskProgress),
      rpc.on<LogPayload>("backend.log", this.handleBackendLog),
    ];

    try {
      await Promise.all([rpc.listen(trackedEvents), rpc.listen(rawEvents, { track: false })]);
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
        [...trackedEvents, ...rawEvents].map((event) => rpc.unlisten(event)),
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
        this.methodPermissions = status.method_permissions ?? {};
        this.lastError = status.last_error;
      });
      if (status.ready) {
        await this.syncTasks();
      } else if (status.phase === "failed") {
        this.scheduleRestart();
      }
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
      this.methodPermissions = payload.method_permissions ?? {};
      this.lastError = null;
      this._restartAttempts = 0;
      if (this._restartTimer !== null) {
        clearTimeout(this._restartTimer);
        this._restartTimer = null;
      }
    });
    void this.syncTasks();
  }

  private handleExited(payload: { reason?: string; recoverable?: boolean }) {
    runInAction(() => {
      this.state = "stopped";
      this.lastError = payload.reason ?? null;
      this.capabilities = [];
      this.methodPermissions = {};
      this.tasks.clear();
    });
    if (!payload.recoverable && this._restartTimer !== null) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
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

  private handleTaskUpdated(payload: TaskSnapshot) {
    runInAction(() => {
      this.setTrackedTask(payload.task_id, {
        taskId: payload.task_id,
        method: payload.method,
        status: payload.status,
        kind: payload.kind,
        cancellable: payload.cancellable,
        cancelRequested: payload.cancel_requested ?? false,
        progress: payload.progress,
        message: payload.message,
        result: payload.result,
        error: payload.error,
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

  private async syncTasks() {
    try {
      const snapshots = await rpc.callKnown("task.list", null);
      runInAction(() => {
        this.tasks.clear();
        for (const snapshot of snapshots) {
          this.setTrackedTask(snapshot.task_id, {
            taskId: snapshot.task_id,
            method: snapshot.method,
            status: snapshot.status,
            kind: snapshot.kind,
            cancellable: snapshot.cancellable,
            cancelRequested: snapshot.cancel_requested ?? false,
            progress: snapshot.progress,
            message: snapshot.message,
            result: snapshot.result,
            error: snapshot.error,
          });
        }
      });
    } catch (error) {
      rpcStore.addBackendLog({
        level: "warning",
        stream: "process",
        source: "frontend",
        message: `Failed to synchronize tasks: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private handleBackendLog(payload: LogPayload) {
    rpcStore.addBackendLog(payload);
  }

  private setTrackedTask(taskId: string, task: TrackedTask) {
    // Refresh insertion order on update, then evict only terminal history.
    // Active tasks are authoritative and must never disappear from the UI.
    this.tasks.delete(taskId);
    this.tasks.set(taskId, task);
    while (this.tasks.size > this.maxTasks) {
      const evictable = [...this.tasks.entries()].find(([, candidate]) =>
        ["completed", "failed", "cancelled"].includes(candidate.status),
      );
      if (evictable === undefined) break;
      this.tasks.delete(evictable[0]);
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
