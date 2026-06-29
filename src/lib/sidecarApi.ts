import { invoke } from "@tauri-apps/api/core";

import type {
  SystemInfoResult,
  TaskCancelResult,
  TaskCatalogResult,
  TaskStartResult,
  TaskStatusResult,
} from "../generated/sidecarTypes";

export async function pingSidecar() {
  return invoke<SystemInfoResult>("sidecar_ping");
}

export async function fetchTaskCatalog() {
  return invoke<TaskCatalogResult>("sidecar_task_catalog");
}

export async function startTask(taskName: string, payload: Record<string, unknown>) {
  return invoke<TaskStartResult>("sidecar_start_task", {
    taskName,
    payload,
  });
}

export async function cancelTask(taskId: string) {
  return invoke<TaskCancelResult>("sidecar_cancel_task", { taskId });
}

export async function fetchTaskStatus(taskId: string) {
  return invoke<TaskStatusResult>("sidecar_task_status", { taskId });
}
