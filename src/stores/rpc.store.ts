import { makeAutoObservable } from "mobx";
import type { LogPayload } from "@/types/generated";
import { redactText, redactValue } from "@/lib/redact";
import { MAX_FRONTEND_LOGS, MAX_FRONTEND_RPC_ENTRIES } from "@/types/protocol";

// 报文流向类型
export type RpcDirection = "request" | "response" | "notification" | "error";

// 报文记录接口
export interface RpcEntry {
  id: string; // 唯一消息 ID
  timestamp: number; // 时间戳
  direction: RpcDirection;
  method?: string; // 请求方法名
  params?: unknown; // 负载参数
  result?: unknown; // 成功响应内容
  error?: string; // 错误原因描述
  duration?: number; // 双向通信耗时（毫秒）
  correlationId?: string;
}

export interface BackendLogEntry {
  id: string;
  timestamp: number;
  level: NonNullable<LogPayload["level"]>;
  stream: NonNullable<LogPayload["stream"]>;
  source: string;
  message: string;
  context?: Record<string, unknown> | null;
}

const logLevels = new Set(["debug", "info", "warning", "error"]);
const logStreams = new Set(["stderr", "process"]);

// 调试面板使用的 RPC 报文存储 Store
class RpcStore {
  entries: RpcEntry[] = [];
  logs: BackendLogEntry[] = [];
  maxEntries = MAX_FRONTEND_RPC_ENTRIES;
  maxLogs = MAX_FRONTEND_LOGS;
  private logIds = new Set<string>();
  private _idCounter = 0; // 单调递增计数器，保证 entry ID 全局唯一、无碰撞

  constructor() {
    makeAutoObservable(this);
  }

  // 追加报文条目，若超过上限则自动丢弃最旧数据
  addEntry(entry: Omit<RpcEntry, "id">) {
    const id = `entry-${++this._idCounter}`;
    this.entries.unshift({ id, ...entry });
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(0, this.maxEntries);
    }
  }

  // 清空报文面板
  clear() {
    this.entries = [];
    this.logs = [];
    this.logIds.clear();
  }

  /**
   * 追踪一次请求和响应。
   * 返回一个闭包，在响应返回时调用，用于自动计算请求处理耗时。
   */
  trackRequest(method: string, params?: unknown, correlationId?: string) {
    const startTime = Date.now();
    this.addEntry({
      timestamp: startTime,
      direction: "request",
      method,
      params: redactValue(params),
      correlationId,
    });
    return (result?: unknown, error?: string) => {
      const endTime = Date.now(); // Fix 6: 单一快照，同时用于 timestamp 和 duration
      this.addEntry({
        timestamp: endTime,
        direction: error ? "error" : "response",
        method,
        result: redactValue(result),
        error,
        duration: endTime - startTime,
        correlationId,
      });
    };
  }

  // 记录主动接收的 Notification 消息
  addNotification(method: string, params?: unknown) {
    this.addEntry({
      timestamp: Date.now(),
      direction: "notification",
      method,
      params: redactValue(params),
    });
  }

  addBackendLog(payload: LogPayload) {
    const level = payload.level && logLevels.has(payload.level) ? payload.level : "info";
    const stream = payload.stream && logStreams.has(payload.stream) ? payload.stream : "stderr";
    const id =
      payload.seq != null
        ? `backend-${payload.seq}`
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (this.logIds.has(id)) {
      return;
    }
    this.logIds.add(id);

    this.logs.unshift({
      id,
      timestamp: payload.timestamp_ms ?? Date.now(),
      level,
      stream,
      source: payload.source ?? "backend",
      message: redactText(payload.message),
      context: redactValue(payload.context) as Record<string, unknown> | null | undefined,
    });

    if (this.logs.length > this.maxLogs) {
      for (const entry of this.logs.slice(this.maxLogs)) {
        this.logIds.delete(entry.id);
      }
      this.logs = this.logs.slice(0, this.maxLogs);
    }
  }
}

export const rpcStore = new RpcStore();
