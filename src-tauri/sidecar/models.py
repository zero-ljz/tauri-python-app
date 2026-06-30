"""
Pydantic 数据模型定义。
这是 JSON-RPC 协议及长短任务模式在前后端类型同步时的“真理源 (Source of Truth)”。
"""
from __future__ import annotations
from typing import Any, Literal, Optional, Union
from pydantic import BaseModel, Field


# ─── JSON-RPC 2.0 基础协议消息模型 ─────────────────────────────────────────────

class RpcRequest(BaseModel):
    """从 Rust 端通过 stdin 接收的 JSON-RPC 2.0 请求实体"""
    jsonrpc: Literal["2.0"] = "2.0"
    id: Optional[str] = None
    method: str
    params: Any = None


class RpcError(BaseModel):
    """JSON-RPC 2.0 错误应答节点"""
    code: int
    message: str
    data: Any = None


class RpcResponse(BaseModel):
    """向 Rust (stdout) 反馈的 JSON-RPC 2.0 响应实体"""
    jsonrpc: Literal["2.0"] = "2.0"
    id: Optional[str] = None
    result: Any = None
    error: Optional[RpcError] = None


class RpcNotification(BaseModel):
    """双向通用的单向通知实体（不需回复，不带 id）"""
    jsonrpc: Literal["2.0"] = "2.0"
    method: str
    params: Any = None


# ─── 任务调度机制专属数据负载模型 ───────────────────────────────────────────────

class TaskStatus(BaseModel):
    """任务运行时的状态快照模型"""
    task_id: str
    method: str
    status: Literal["pending", "running", "done", "error", "cancelled"]
    progress: Optional[float] = Field(None, ge=0.0, le=1.0)
    message: Optional[str] = None


class TaskResult(BaseModel):
    """任务终结时向主控端回执的最终计算结果包"""
    task_id: str
    method: str
    result: Any = None
    error: Optional[str] = None


class TaskProgress(BaseModel):
    """长任务执行期间，向前端推送的实时增量进度模型"""
    task_id: str
    progress: float = Field(ge=0.0, le=1.0)
    message: Optional[str] = None


# ─── 广播类状态通知数据模型 ─────────────────────────────────────────────────────

class SidecarReadyPayload(BaseModel):
    """Sidecar 启动自检就绪后，向 Rust 宣告能力的就绪通知负载"""
    version: str
    capabilities: list[str] = []


class LogPayload(BaseModel):
    """主动向调试台推送的格式化日志包，配合 Debug 面板的实时展现"""
    level: Literal["debug", "info", "warning", "error"]
    message: str
    context: Optional[dict[str, Any]] = None
