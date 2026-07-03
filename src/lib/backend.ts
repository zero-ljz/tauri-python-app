import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { rpcStore } from "@/stores/rpc.store";
import type { LogPayload } from "@/types/generated";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function backendRequest<T = unknown>(
  method: string,
  params?: unknown
): Promise<T> {
  const finish = rpcStore.trackRequest(method, params ?? null);
  try {
    const result = await invoke<T>("backend_request", { method, params: params ?? null });
    finish(result);
    return result;
  } catch (error) {
    finish(undefined, errorMessage(error));
    throw error;
  }
}

export async function backendNotify(method: string, params?: unknown): Promise<void> {
  return invoke("backend_notify", { method, params: params ?? null });
}

export function listenBackend<T = unknown>(
  method: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(`backend://${method}`, (event) => {
    rpcStore.addNotification(method, event.payload);
    handler(event.payload);
  });
}

export function listenBackendRaw<T = unknown>(
  method: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(`backend://${method}`, (event) => {
    handler(event.payload);
  });
}

export const backendStatus = () => invoke<boolean>("backend_status");
export const backendLogs = () => invoke<LogPayload[]>("backend_logs");
export const backendStop = () => invoke("backend_stop");
