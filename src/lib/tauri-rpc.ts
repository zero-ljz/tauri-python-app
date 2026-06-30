import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { rpcStore } from "@/stores/rpc.store";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 通用的 JSON-RPC 2.0 请求代理（前端 -> Rust -> Python Sidecar）
 */
export async function rpcRequest<T = unknown>(
  method: string,
  params?: unknown
): Promise<T> {
  const finish = rpcStore.trackRequest(method, params ?? null);
  try {
    const result = await invoke<T>("rpc_request", { method, params: params ?? null });
    finish(result);
    return result;
  } catch (error) {
    finish(undefined, errorMessage(error));
    throw error;
  }
}

/**
 * 发送单向 JSON-RPC 2.0 通知给 Python Sidecar（无响应）
 */
export async function rpcNotify(method: string, params?: unknown): Promise<void> {
  return invoke("rpc_notify", { method, params: params ?? null });
}

/**
 * 监听 Python Sidecar 推送的 Notification 消息
 * 事件名称格式统一为：`sidecar://{method}`
 */
export function listenSidecar<T = unknown>(
  method: string,
  handler: (payload: T) => void
): Promise<UnlistenFn> {
  return listen<T>(`sidecar://${method}`, (event) => {
    rpcStore.addNotification(method, event.payload);
    handler(event.payload);
  });
}

// ─── 无边框窗口控制 API ───────────────────────────────────────────────────────

export const windowMinimize = () => invoke("window_minimize");
export const windowMaximize = () => invoke("window_maximize");
export const windowClose = () => invoke("window_close");
export const windowIsMaximized = () => invoke<boolean>("window_is_maximized");
export const windowStartDrag = () => invoke("window_start_drag");

// ─── Sidecar 状态查询 API ─────────────────────────────────────────────────────

export const sidecarStatus = () => invoke<boolean>("sidecar_status");
export const sidecarStop = () => invoke("sidecar_stop");
