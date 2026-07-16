import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { rpcStore } from "@/stores/rpc.store";
import type {
  LogPayload,
  RpcMethod,
  RpcParams,
  RpcResult,
} from "@/types/generated";

export type RpcEventHandler<T = unknown> = (payload: T) => void;

export interface RpcListenOptions {
  track?: boolean;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const value = error as { code?: unknown; message?: unknown };
    const message = String(value.message);
    return value.code == null ? message : `${message} (code ${String(value.code)})`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface BackendStatusPayload {
  phase: "stopped" | "starting" | "ready" | "stopping" | "failed";
  generation: number;
  running: boolean;
  ready: boolean;
  version: string | null;
  capabilities: string[];
  last_error: string | null;
}

const backendEventName = (method: string) =>
  `backend://${method.split(".").join("/")}`;

class TauriRpcClient {
  private handlers = new Map<string, Set<RpcEventHandler>>();
  private unlisteners = new Map<string, Promise<UnlistenFn>>();
  private trackNotifications = new Map<string, boolean>();

  async call<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T> {
    const finish = rpcStore.trackRequest(method, params ?? null);

    try {
      const result = await invoke<T>("backend_request", {
        method,
        params: params ?? null,
        timeoutMs: timeout,
      });
      finish(result);
      return result;
    } catch (error) {
      finish(undefined, errorMessage(error));
      throw error;
    }
  }

  async callKnown<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    timeout?: number
  ): Promise<RpcResult<M>> {
    return this.call<RpcResult<M>>(method, params, timeout);
  }

  async notify(method: string, params?: unknown, timeout?: number): Promise<void> {
    return invoke("backend_notify", {
      method,
      params: params ?? null,
      timeoutMs: timeout,
    });
  }

  async listen(
    event: string,
    options?: RpcListenOptions
  ): Promise<void>;
  async listen(
    event: string[],
    options?: RpcListenOptions
  ): Promise<Record<string, true>>;
  async listen(
    event: string | string[],
    options: RpcListenOptions = {}
  ): Promise<void | Record<string, true>> {
    if (Array.isArray(event)) {
      await Promise.all(event.map((name) => this.listenOne(name, options)));
      return Object.fromEntries(event.map((name) => [name, true]));
    }

    await this.listenOne(event, options);
  }

  async unlisten(event: string): Promise<void>;
  async unlisten(event: string[]): Promise<Record<string, true>>;
  async unlisten(event: string | string[]): Promise<void | Record<string, true>> {
    if (Array.isArray(event)) {
      await Promise.all(event.map((name) => this.unlistenOne(name)));
      return Object.fromEntries(event.map((name) => [name, true]));
    }

    await this.unlistenOne(event);
  }

  on<T = unknown>(event: string, handler: RpcEventHandler<T>): () => void {
    const handlers = this.handlers.get(event) ?? new Set<RpcEventHandler>();
    handlers.add(handler as RpcEventHandler);
    this.handlers.set(event, handlers);

    return () => this.off(event, handler);
  }

  off<T = unknown>(event: string, handler: RpcEventHandler<T>): void {
    const handlers = this.handlers.get(event);
    handlers?.delete(handler as RpcEventHandler);
    if (handlers?.size === 0) {
      this.handlers.delete(event);
    }
  }

  async close(): Promise<void> {
    const events = [...this.unlisteners.keys()];
    await Promise.all(events.map((event) => this.unlistenOne(event)));
    this.handlers.clear();
  }

  private async listenOne(event: string, options: RpcListenOptions): Promise<void> {
    if (this.unlisteners.has(event)) {
      if (options.track !== undefined) {
        this.trackNotifications.set(event, options.track);
      }
      return;
    }

    this.trackNotifications.set(event, options.track ?? true);
    const unlisten = listen<unknown>(backendEventName(event), (message) => {
      if (this.trackNotifications.get(event) !== false) {
        rpcStore.addNotification(event, message.payload);
      }

      for (const handler of this.handlers.get(event) ?? []) {
        handler(message.payload);
      }
    });

    this.unlisteners.set(event, unlisten);
    try {
      await unlisten;
    } catch (error) {
      this.unlisteners.delete(event);
      this.trackNotifications.delete(event);
      throw error;
    }
  }

  private async unlistenOne(event: string): Promise<void> {
    const unlisten = this.unlisteners.get(event);
    if (!unlisten) {
      return;
    }

    this.unlisteners.delete(event);
    this.trackNotifications.delete(event);
    this.handlers.delete(event);
    (await unlisten)();
  }
}

export const rpc = new TauriRpcClient();

export const rpcCall = <M extends RpcMethod>(
  method: M,
  params: RpcParams<M>,
  timeout?: number
) => rpc.callKnown(method, params, timeout);

export const rpcNotify = (method: string, params?: unknown) => rpc.notify(method, params);
export function rpcListen(
  event: string,
  options?: RpcListenOptions
): Promise<void>;
export function rpcListen(
  event: string[],
  options?: RpcListenOptions
): Promise<Record<string, true>>;
export function rpcListen(
  event: string | string[],
  options?: RpcListenOptions
): Promise<void | Record<string, true>> {
  return Array.isArray(event) ? rpc.listen(event, options) : rpc.listen(event, options);
}

export function rpcUnlisten(event: string): Promise<void>;
export function rpcUnlisten(event: string[]): Promise<Record<string, true>>;
export function rpcUnlisten(event: string | string[]): Promise<void | Record<string, true>> {
  return Array.isArray(event) ? rpc.unlisten(event) : rpc.unlisten(event);
}

export const backendStatus = () => invoke<BackendStatusPayload>("backend_status");
export const backendLogs = () => invoke<LogPayload[]>("backend_logs");
export const backendStart = () => invoke("backend_start");
export const backendStop = () => invoke("backend_stop");
export const backendRestart = () => invoke("backend_restart");
