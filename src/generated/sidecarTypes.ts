/* eslint-disable */
// Generated from backend/sidecar/schemas.py. Do not edit by hand.

export interface RpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown | null;
}

export interface SystemInfoResult {
  ok?: boolean;
  pid: number;
  python_version: string;
  platform: string;
}

export interface AsyncSleepPayload {
  duration_ms?: number;
  steps?: number;
}

export interface BlockingIoPayload {
  duration_ms?: number;
}

export interface CpuCountPayload {
  limit?: number;
  timeout_ms?: number;
}

export interface TaskDescriptor {
  name: string;
  title: string;
  kind: "async_io" | "blocking_io";
  description: string;
  default_payload: Record<string, unknown>;
}

export interface TaskCatalogResult {
  tasks: TaskDescriptor[];
}

export interface TaskStartParams {
  task_name: string;
  payload?: Record<string, unknown>;
}

export interface TaskStartResult {
  task_id: string;
  task_name: string;
  state: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  accepted_at: string;
}

export interface TaskCancelParams {
  task_id: string;
}

export interface TaskCancelResult {
  task_id: string;
  accepted: boolean;
  state: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
}

export interface TaskStatusParams {
  task_id: string;
}

export interface TaskStatusResult {
  task_id: string;
  task_name: string;
  kind: "async_io" | "blocking_io";
  state: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
  progress: number;
  message?: string | null;
  result?: unknown | null;
  error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}
