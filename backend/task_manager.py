"""Bounded, queryable task registry for async and blocking backend work."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from backend.models import (
    TaskCancelResult,
    TaskKind,
    TaskProgress,
    TaskRemoveResult,
    TaskSnapshot,
    TaskState,
)
from backend.protocol import send_notification
from backend.protocol_config import MAX_TASK_HISTORY
from backend.redaction import redact_text

logger = logging.getLogger(__name__)

_thread_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="backend-worker")
_TERMINAL_STATES = {"completed", "failed", "cancelled"}


@dataclass
class TaskHandle:
    task_id: str
    method: str
    kind: TaskKind
    cancellable: bool
    asyncio_task: asyncio.Task | None = field(default=None, repr=False)
    status: TaskState = "queued"
    cancel_requested: bool = False
    progress: float | None = None
    message: str | None = None
    result: Any = None
    error: str | None = None


class TaskRegistry:
    """Owns task state; queries are authoritative and notifications are hints."""

    def __init__(self, max_history: int = MAX_TASK_HISTORY) -> None:
        self._tasks: dict[str, TaskHandle] = {}
        self._closed = False
        self._max_history = max_history

    def _new_id(self) -> str:
        return str(uuid.uuid4())

    @staticmethod
    def _snapshot(handle: TaskHandle) -> dict[str, Any]:
        return TaskSnapshot(
            task_id=handle.task_id,
            method=handle.method,
            status=handle.status,
            kind=handle.kind,
            cancellable=handle.cancellable,
            cancel_requested=handle.cancel_requested,
            progress=handle.progress,
            message=handle.message,
            result=handle.result,
            error=handle.error,
        ).model_dump()

    async def _notify_updated(self, handle: TaskHandle) -> None:
        await send_notification("task.updated", self._snapshot(handle))

    def _trim_history(self) -> None:
        overflow = len(self._tasks) - self._max_history
        if overflow <= 0:
            return
        for task_id, handle in list(self._tasks.items()):
            if overflow <= 0:
                break
            if handle.status in _TERMINAL_STATES:
                self._tasks.pop(task_id, None)
                overflow -= 1

    async def _run_async(
        self,
        task_id: str,
        coro: Awaitable[Any],
    ) -> None:
        handle = self._tasks[task_id]
        handle.status = "running"
        await self._notify_updated(handle)

        try:
            handle.result = await coro
            handle.status = "completed"
            handle.progress = 1.0
        except asyncio.CancelledError:
            handle.status = "cancelled"
            handle.cancel_requested = True
        except Exception as error:
            logger.exception("任务 %s 抛出异常: %s", task_id, error)
            handle.status = "failed"
            handle.error = redact_text(str(error), max_length=1000)
        finally:
            await self._notify_updated(handle)
            self._trim_history()

    def submit_async(
        self,
        method: str,
        coro_factory: Callable[[], Awaitable[Any]],
    ) -> str:
        if self._closed:
            raise RuntimeError("task registry is shutting down")
        task_id = self._new_id()
        handle = TaskHandle(task_id, method, "async", True)
        self._tasks[task_id] = handle
        try:
            work = coro_factory()
        except Exception:
            self._tasks.pop(task_id, None)
            raise
        handle.asyncio_task = asyncio.create_task(
            self._run_async(task_id, work), name=f"task-{task_id}"
        )
        return task_id

    def submit_blocking(self, method: str, fn: Callable[[], Any]) -> str:
        if self._closed:
            raise RuntimeError("task registry is shutting down")
        task_id = self._new_id()
        handle = TaskHandle(task_id, method, "blocking", False)
        self._tasks[task_id] = handle
        loop = asyncio.get_running_loop()

        async def wrapper() -> Any:
            return await loop.run_in_executor(_thread_pool, fn)

        handle.asyncio_task = asyncio.create_task(
            self._run_async(task_id, wrapper()), name=f"task-{task_id}"
        )
        return task_id

    async def cancel(self, task_id: str) -> dict[str, Any]:
        handle = self._tasks.get(task_id)
        if handle is None:
            return TaskCancelResult(
                task_id=task_id, cancelled=False, reason="task not found"
            ).model_dump()
        if handle.status in _TERMINAL_STATES:
            return TaskCancelResult(
                task_id=task_id,
                cancelled=False,
                reason=f"task is already {handle.status}",
            ).model_dump()

        handle.cancel_requested = True
        if not handle.cancellable:
            handle.message = "blocking task cannot be interrupted once it is running"
            await self._notify_updated(handle)
            return TaskCancelResult(
                task_id=task_id, cancelled=False, reason=handle.message
            ).model_dump()

        if handle.asyncio_task is not None:
            handle.asyncio_task.cancel()
            return TaskCancelResult(task_id=task_id, cancelled=True).model_dump()
        return TaskCancelResult(
            task_id=task_id,
            cancelled=False,
            reason="task has no cancellable asyncio handle",
        ).model_dump()

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        handle = self._tasks.get(task_id)
        return self._snapshot(handle) if handle is not None else None

    def list_tasks(self) -> list[dict[str, Any]]:
        return [self._snapshot(handle) for handle in self._tasks.values()]

    def remove(self, task_id: str) -> dict[str, Any]:
        handle = self._tasks.get(task_id)
        if handle is None:
            return TaskRemoveResult(
                task_id=task_id, removed=False, reason="task not found"
            ).model_dump()
        if handle.status not in _TERMINAL_STATES:
            return TaskRemoveResult(
                task_id=task_id, removed=False, reason="active task cannot be removed"
            ).model_dump()
        self._tasks.pop(task_id, None)
        return TaskRemoveResult(task_id=task_id, removed=True).model_dump()

    async def send_progress(
        self,
        task_id: str,
        progress: float,
        message: str | None = None,
    ) -> None:
        handle = self._tasks.get(task_id)
        if handle is None or handle.status in _TERMINAL_STATES:
            logger.debug("忽略不存在或已结束任务的进度通知: %s", task_id)
            return
        handle.progress = progress
        handle.message = message
        await send_notification(
            "task.progress",
            TaskProgress(task_id=task_id, progress=progress, message=message).model_dump(),
        )

    async def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        tasks = [
            handle.asyncio_task
            for handle in self._tasks.values()
            if handle.asyncio_task is not None and handle.status not in _TERMINAL_STATES
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        _thread_pool.shutdown(wait=False, cancel_futures=True)
