import { makeAutoObservable, runInAction } from "mobx";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  cancelTask,
  fetchTaskCatalog,
  fetchTaskStatus,
  pingSidecar,
  startTask,
} from "../lib/sidecarApi";
import type {
  RpcNotification,
  SystemInfoResult,
  TaskDescriptor,
  TaskStatusResult,
} from "../generated/sidecarTypes";

type ConnectionState = "idle" | "connecting" | "ready" | "error";

export class TaskRuntimeStore {
  connection: ConnectionState = "idle";
  systemInfo: SystemInfoResult | null = null;
  catalog: TaskDescriptor[] = [];
  runs = new Map<string, TaskStatusResult>();
  payloadDrafts = new Map<string, string>();
  busyTaskNames = new Set<string>();
  lastError = "";

  private initialized = false;
  private listenerGeneration = 0;
  private unlistenFns: UnlistenFn[] = [];

  constructor() {
    makeAutoObservable(this);
  }

  get runList() {
    return Array.from(this.runs.values()).reverse();
  }

  get activeRunCount() {
    return this.runList.filter((run) => ["queued", "running", "cancelling"].includes(run.state))
      .length;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const generation = ++this.listenerGeneration;
    this.connection = "connecting";

    const notificationUnlisten = await listen<RpcNotification>("sidecar://notification", (event) =>
      this.handleNotification(event.payload),
    );

    if (generation !== this.listenerGeneration) {
      notificationUnlisten();
      return;
    }

    this.unlistenFns = [notificationUnlisten];

    await this.refresh();
  }

  dispose() {
    this.listenerGeneration += 1;
    for (const unlisten of this.unlistenFns) {
      unlisten();
    }
    this.unlistenFns = [];
    this.initialized = false;
  }

  async refresh() {
    this.connection = "connecting";
    this.lastError = "";
    try {
      const [info, catalog] = await Promise.all([pingSidecar(), fetchTaskCatalog()]);
      runInAction(() => {
        this.systemInfo = info;
        this.catalog = catalog.tasks;
        for (const task of catalog.tasks) {
          if (!this.payloadDrafts.has(task.name)) {
            this.payloadDrafts.set(task.name, JSON.stringify(task.default_payload, null, 2));
          }
        }
        this.connection = "ready";
      });
    } catch (error) {
      runInAction(() => {
        this.connection = "error";
        this.lastError = stringifyError(error);
      });
    }
  }

  setPayloadDraft(taskName: string, value: string) {
    this.payloadDrafts.set(taskName, value);
  }

  async start(task: TaskDescriptor) {
    this.lastError = "";
    this.busyTaskNames.add(task.name);
    try {
      const payload = parsePayload(this.payloadDrafts.get(task.name) ?? "{}");
      const result = await startTask(task.name, payload);
      runInAction(() => {
        this.runs.set(result.task_id, {
          task_id: result.task_id,
          task_name: result.task_name,
          kind: task.kind,
          state: result.state,
          progress: 0,
          message: "accepted",
          result: null,
          error: null,
          started_at: null,
          finished_at: null,
        });
      });
    } catch (error) {
      runInAction(() => {
        this.lastError = stringifyError(error);
      });
    } finally {
      runInAction(() => {
        this.busyTaskNames.delete(task.name);
      });
    }
  }

  async cancel(taskId: string) {
    this.lastError = "";
    try {
      await cancelTask(taskId);
      const status = await fetchTaskStatus(taskId);
      runInAction(() => {
        this.runs.set(status.task_id, status);
      });
    } catch (error) {
      runInAction(() => {
        this.lastError = stringifyError(error);
      });
    }
  }

  private handleNotification(notification: RpcNotification) {
    if (!notification.method.startsWith("task.") || !isTaskStatus(notification.params)) {
      return;
    }
    this.runs.set(notification.params.task_id, notification.params);
  }
}

function parsePayload(source: string) {
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function isTaskStatus(value: unknown): value is TaskStatusResult {
  return (
    !!value &&
    typeof value === "object" &&
    "task_id" in value &&
    "task_name" in value &&
    "state" in value &&
    "progress" in value
  );
}

function stringifyError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export const taskRuntimeStore = new TaskRuntimeStore();
