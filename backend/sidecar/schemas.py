from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

JsonValue = Any

TaskKind = Literal["async_io", "blocking_io"]
TaskState = Literal[
    "queued",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RpcNotification(StrictModel):
    jsonrpc: Literal["2.0"] = "2.0"
    method: str
    params: JsonValue | None = None


class SystemInfoResult(StrictModel):
    ok: bool = True
    pid: int
    python_version: str
    platform: str


class AsyncSleepPayload(StrictModel):
    duration_ms: int = Field(default=4000, ge=100, le=120000)
    steps: int = Field(default=8, ge=1, le=100)


class BlockingIoPayload(StrictModel):
    duration_ms: int = Field(default=2500, ge=100, le=120000)


class CpuCountPayload(StrictModel):
    limit: int = Field(default=75000, ge=1000, le=2_000_000)
    timeout_ms: int = Field(default=60000, ge=1000, le=600000)


class TaskDescriptor(StrictModel):
    name: str
    title: str
    kind: TaskKind
    description: str
    default_payload: dict[str, JsonValue]


class TaskCatalogResult(StrictModel):
    tasks: list[TaskDescriptor]


class TaskStartParams(StrictModel):
    task_name: str
    payload: dict[str, JsonValue] = Field(default_factory=dict)


class TaskStartResult(StrictModel):
    task_id: str
    task_name: str
    state: TaskState
    accepted_at: str


class TaskCancelParams(StrictModel):
    task_id: str


class TaskCancelResult(StrictModel):
    task_id: str
    accepted: bool
    state: TaskState


class TaskStatusParams(StrictModel):
    task_id: str


class TaskStatusResult(StrictModel):
    task_id: str
    task_name: str
    kind: TaskKind
    state: TaskState
    progress: float = Field(ge=0.0, le=1.0)
    message: str | None = None
    result: JsonValue | None = None
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None


TYPE_MODELS: tuple[type[BaseModel], ...] = (
    RpcNotification,
    SystemInfoResult,
    AsyncSleepPayload,
    BlockingIoPayload,
    CpuCountPayload,
    TaskDescriptor,
    TaskCatalogResult,
    TaskStartParams,
    TaskStartResult,
    TaskCancelParams,
    TaskCancelResult,
    TaskStatusParams,
    TaskStatusResult,
)
