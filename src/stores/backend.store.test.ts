import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSnapshot } from "@/types/generated";

const mocks = vi.hoisted(() => ({
  backendLogs: vi.fn(),
  backendStart: vi.fn(),
  backendStatus: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  on: vi.fn(),
  callKnown: vi.fn(),
}));

vi.mock("@/lib/rpc", () => ({
  backendLogs: mocks.backendLogs,
  backendStart: mocks.backendStart,
  backendStatus: mocks.backendStatus,
  rpc: {
    listen: mocks.listen,
    unlisten: mocks.unlisten,
    on: mocks.on,
    callKnown: mocks.callKnown,
  },
}));

import { BackendStore } from "@/stores/backend.store";

function snapshot(taskId: string, status: TaskSnapshot["status"]): TaskSnapshot {
  return {
    task_id: taskId,
    method: "test.task",
    status,
    kind: "async",
    cancellable: true,
    cancel_requested: false,
    progress: null,
    message: null,
    result: null,
    error: null,
  };
}

function deliverTask(store: BackendStore, task: TaskSnapshot): void {
  const target = store as unknown as { handleTaskUpdated(payload: TaskSnapshot): void };
  target.handleTaskUpdated(task);
}

describe("BackendStore", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.backendLogs.mockResolvedValue([]);
    mocks.listen.mockResolvedValue(undefined);
    mocks.unlisten.mockResolvedValue(undefined);
    mocks.on.mockReturnValue(() => undefined);
    mocks.callKnown.mockResolvedValue([]);
    mocks.backendStart.mockResolvedValue(undefined);
  });

  it("retries when startup failed before event listeners observed the exit", async () => {
    vi.useFakeTimers();
    mocks.backendStatus.mockResolvedValue({
      phase: "failed",
      generation: 1,
      running: false,
      ready: false,
      version: null,
      capabilities: [],
      method_permissions: {},
      last_error: "python missing",
    });
    const store = new BackendStore();
    await store.init();
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.backendStart).toHaveBeenCalledOnce();
    store.dispose();
  });

  it("evicts terminal history before active tasks", () => {
    const store = new BackendStore();
    deliverTask(store, snapshot("old-completed", "completed"));
    for (let index = 0; index < 499; index += 1) {
      deliverTask(store, snapshot(`active-${index}`, "running"));
    }
    deliverTask(store, snapshot("new-active", "running"));
    expect(store.tasks.size).toBe(500);
    expect(store.tasks.has("old-completed")).toBe(false);
    expect(store.tasks.has("new-active")).toBe(true);
  });
});
