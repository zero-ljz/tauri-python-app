import { makeAutoObservable, runInAction } from "mobx";
import { backendLogs, backendStatus, rpc } from "@/lib/rpc";
import { rpcStore } from "@/stores/rpc.store";
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
  private _offHandlers: Array<() => void> = [];
  private _subscriptions: string[] = [];

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
      rpc.on<{ reason?: string }>("backend.exited", this.handleExited),
      rpc.on<TaskStatus>("task.status", this.handleTaskStatus),
      rpc.on<TaskProgress>("task.progress", this.handleTaskProgress),
      rpc.on<TaskResult>("task.result", this.handleTaskResult),
      rpc.on<LogPayload>("backend.log", this.handleBackendLog),
    ];

    try {
      await Promise.all([
        rpc.subscribe(trackedEvents),
        rpc.subscribe(rawEvents, { track: false }),
      ]);
      runInAction(() => {
        this._offHandlers = offHandlers;
        this._subscriptions = [...trackedEvents, ...rawEvents];
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
    for (const off of this._offHandlers) {
      off();
    }
    for (const event of this._subscriptions) {
      void rpc.unsubscribe(event);
    }
    this._offHandlers = [];
    this._subscriptions = [];
  }
}

export const backendStore = new BackendStore();
