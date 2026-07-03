import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { rpcStore } from "@/stores/rpc.store";
import type { LogPayload } from "@/types/generated";

export type RpcEventHandler<T = unknown> = (payload: T) => void;

export interface RpcSubscribeOptions {
  track?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class TauriRpcClient {
  private handlers = new Map<string, Set<RpcEventHandler>>();
  private unlisteners = new Map<string, Promise<UnlistenFn>>();
  private trackNotifications = new Map<string, boolean>();

  async call<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T> {
    const finish = rpcStore.trackRequest(method, params ?? null);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const request = invoke<T>("backend_request", { method, params: params ?? null });

    try {
      const result =
        timeout == null
          ? await request
          : await Promise.race([
              request,
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(
                  () => reject(new Error(`RPC call timed out: ${method}`)),
                  timeout
                );
              }),
            ]);
      finish(result);
      return result;
    } catch (error) {
      finish(undefined, errorMessage(error));
      throw error;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    return invoke("backend_notify", { method, params: params ?? null });
  }

  async subscribe(
    event: string,
    options?: RpcSubscribeOptions
  ): Promise<void>;
  async subscribe(
    event: string[],
    options?: RpcSubscribeOptions
  ): Promise<Record<string, true>>;
  async subscribe(
    event: string | string[],
    options: RpcSubscribeOptions = {}
  ): Promise<void | Record<string, true>> {
    if (Array.isArray(event)) {
      await Promise.all(event.map((name) => this.subscribeOne(name, options)));
      return Object.fromEntries(event.map((name) => [name, true]));
    }

    await this.subscribeOne(event, options);
  }

  async unsubscribe(event: string): Promise<void>;
  async unsubscribe(event: string[]): Promise<Record<string, true>>;
  async unsubscribe(event: string | string[]): Promise<void | Record<string, true>> {
    if (Array.isArray(event)) {
      await Promise.all(event.map((name) => this.unsubscribeOne(name)));
      return Object.fromEntries(event.map((name) => [name, true]));
    }

    await this.unsubscribeOne(event);
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
    await Promise.all(events.map((event) => this.unsubscribeOne(event)));
    this.handlers.clear();
  }

  private async subscribeOne(event: string, options: RpcSubscribeOptions): Promise<void> {
    if (this.unlisteners.has(event)) {
      if (options.track !== undefined) {
        this.trackNotifications.set(event, options.track);
      }
      return;
    }

    this.trackNotifications.set(event, options.track ?? true);
    const unlisten = listen<unknown>(`backend://${event}`, (message) => {
      if (this.trackNotifications.get(event) !== false) {
        rpcStore.addNotification(event, message.payload);
      }

      for (const handler of this.handlers.get(event) ?? []) {
        handler(message.payload);
      }
    });

    this.unlisteners.set(event, unlisten);
    await unlisten;
  }

  private async unsubscribeOne(event: string): Promise<void> {
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

export const rpcCall = <T = unknown>(
  method: string,
  params?: unknown,
  timeout?: number
) => rpc.call<T>(method, params, timeout);

export const rpcNotify = (method: string, params?: unknown) => rpc.notify(method, params);
export function rpcSubscribe(
  event: string,
  options?: RpcSubscribeOptions
): Promise<void>;
export function rpcSubscribe(
  event: string[],
  options?: RpcSubscribeOptions
): Promise<Record<string, true>>;
export function rpcSubscribe(
  event: string | string[],
  options?: RpcSubscribeOptions
): Promise<void | Record<string, true>> {
  return Array.isArray(event) ? rpc.subscribe(event, options) : rpc.subscribe(event, options);
}

export function rpcUnsubscribe(event: string): Promise<void>;
export function rpcUnsubscribe(event: string[]): Promise<Record<string, true>>;
export function rpcUnsubscribe(event: string | string[]): Promise<void | Record<string, true>> {
  return Array.isArray(event) ? rpc.unsubscribe(event) : rpc.unsubscribe(event);
}

export const backendStatus = () => invoke<boolean>("backend_status");
export const backendLogs = () => invoke<LogPayload[]>("backend_logs");
export const backendStop = () => invoke("backend_stop");
