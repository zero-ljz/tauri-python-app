"""
Pydantic 数据模型定义。
这是 JSON-RPC 协议及长短任务模式在前后端类型同步时的“真理源 (Source of Truth)”。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, RootModel

JsonRpcId = str | int | None

# ─── JSON-RPC 2.0 基础协议消息模型 ─────────────────────────────────────────────


class RpcRequest(BaseModel):
    """从 Rust 端通过 stdin 接收的 JSON-RPC 2.0 请求实体"""

    jsonrpc: Literal["2.0"] = "2.0"
    id: JsonRpcId = None
    method: str
    params: Any = None


class RpcError(BaseModel):
    """JSON-RPC 2.0 错误应答节点"""

    code: int
    message: str
    data: Any = None


class RpcSuccessResponse(BaseModel):
    """向 Rust (stdout) 反馈的 JSON-RPC 2.0 成功响应实体"""

    jsonrpc: Literal["2.0"] = "2.0"
    id: JsonRpcId = None
    result: Any


class RpcErrorResponse(BaseModel):
    """向 Rust (stdout) 反馈的 JSON-RPC 2.0 错误响应实体"""

    jsonrpc: Literal["2.0"] = "2.0"
    id: JsonRpcId = None
    error: RpcError


class RpcResponse(RootModel[RpcSuccessResponse | RpcErrorResponse]):
    """JSON-RPC 2.0 响应联合类型：成功响应与错误响应互斥"""

    pass


class RpcNotification(BaseModel):
    """双向通用的单向通知实体（不需回复，不带 id）"""

    jsonrpc: Literal["2.0"] = "2.0"
    method: str
    params: Any = None


class ImplementationInfo(BaseModel):
    name: str
    version: str


class InitializeParams(BaseModel):
    protocol_version: str
    client: ImplementationInfo
    capabilities: dict[str, Any] = Field(default_factory=dict)


class InitializeResult(BaseModel):
    protocol_version: str
    server: ImplementationInfo
    capabilities: dict[str, Any] = Field(default_factory=dict)


# ─── 任务调度机制专属数据负载模型 ───────────────────────────────────────────────

TaskKind = Literal["async", "blocking"]
TaskState = Literal["queued", "running", "completed", "failed", "cancelled"]


class TaskProgress(BaseModel):
    """长任务执行期间，向前端推送的实时增量进度模型"""

    task_id: str
    progress: float = Field(ge=0.0, le=1.0)
    message: str | None = None


class TaskSnapshot(BaseModel):
    """任务查询与 task.updated 通知使用的权威快照。"""

    task_id: str
    method: str
    status: TaskState
    kind: TaskKind
    cancellable: bool
    cancel_requested: bool = False
    progress: float | None = Field(None, ge=0.0, le=1.0)
    message: str | None = None
    result: Any = None
    error: str | None = None


class TaskCancelResult(BaseModel):
    """任务取消请求的语义化结果"""

    task_id: str
    cancelled: bool
    reason: str | None = None


class TaskCancelParams(BaseModel):
    """Parameters accepted by task.cancel."""

    task_id: str = Field(min_length=1)


class TaskGetParams(BaseModel):
    task_id: str = Field(min_length=1)


class TaskRemoveResult(BaseModel):
    task_id: str
    removed: bool
    reason: str | None = None


class TaskIdResult(BaseModel):
    """Response returned when a background task is submitted."""

    task_id: str


# ─── 广播类状态通知数据模型 ─────────────────────────────────────────────────────


class BackendReadyPayload(BaseModel):
    """Backend 启动自检就绪后，向 Rust 宣告能力的就绪通知负载"""

    version: str
    protocol_version: str
    capabilities: list[str] = Field(default_factory=list)
    method_permissions: dict[str, str] = Field(default_factory=dict)


class LogPayload(BaseModel):
    """主动向调试台推送的格式化日志包，配合 Debug 面板的实时展现"""

    seq: int | None = None
    timestamp_ms: int | None = None
    level: Literal["debug", "info", "warning", "error"] = "info"
    stream: Literal["stderr", "process"] = "stderr"
    source: str = "backend"
    message: str
    context: dict[str, Any] | None = None
