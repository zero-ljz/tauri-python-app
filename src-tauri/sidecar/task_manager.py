"""
任务运行时调度器：实现同步/异步双通道任务管理器。
- 异步 I/O 协程任务 -> 直接挂载在 asyncio.create_task。
- 密集型/阻塞式 CPU 或 IO 任务 -> 调用 loop.run_in_executor 挂载在 ThreadPoolExecutor 线程池。
"""
from __future__ import annotations
import asyncio
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable, Optional

from protocol import send_notification
from models import TaskStatus, TaskResult, TaskProgress, TaskSummary, TaskCancelResult

logger = logging.getLogger(__name__)

# 为阻塞类任务建立专属的共享工作线程池，防止占满 asyncio 事件循环主线程
_thread_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sidecar-worker")


@dataclass
class TaskHandle:
    """任务句柄实体，持有任务运行时上下文以供中止等控制使用"""
    task_id: str
    method: str
    kind: str
    cancellable: bool
    asyncio_task: Optional[asyncio.Task] = field(default=None, repr=False)
    status: str = "pending"
    cancel_requested: bool = False


class TaskRegistry:
    """
    动态任务中心注册表：管理 task_id -> TaskHandle。
    自动通过 Notification 通道向父进程推送执行进度及退出状态。
    """

    def __init__(self) -> None:
        self._tasks: dict[str, TaskHandle] = {}

    def _new_id(self) -> str:
        return str(uuid.uuid4())

    async def _run_async(
        self,
        task_id: str,
        method: str,
        coro: Awaitable[Any],
    ) -> None:
        """任务执行外层包装，捕获取消、完成、报错状态并自动通知 Rust。"""
        handle = self._tasks.get(task_id)
        if handle:
            handle.status = "running"

        # 推送任务进入 running 状态
        await send_notification("task.status", TaskStatus(
            task_id=task_id,
            method=method,
            status="running",
            kind=handle.kind if handle else None,
            cancellable=handle.cancellable if handle else None,
            cancel_requested=handle.cancel_requested if handle else False,
        ).model_dump())

        try:
            result = await coro
            if handle:
                handle.status = "done"
            await send_notification("task.status", TaskStatus(
                task_id=task_id,
                method=method,
                status="done",
                kind=handle.kind if handle else None,
                cancellable=handle.cancellable if handle else None,
                cancel_requested=handle.cancel_requested if handle else False,
                progress=1.0,
            ).model_dump())
            # 执行成功，返回最终 result
            await send_notification("task.result", TaskResult(
                task_id=task_id, method=method, result=result
            ).model_dump())
        except asyncio.CancelledError:
            if handle:
                handle.status = "cancelled"
            # 任务被终止取消，发送 cancelled 状态通知
            await send_notification("task.status", TaskStatus(
                task_id=task_id,
                method=method,
                status="cancelled",
                kind=handle.kind if handle else None,
                cancellable=handle.cancellable if handle else None,
                cancel_requested=True,
            ).model_dump())
        except Exception as e:
            logger.exception("任务 %s 抛出异常崩溃: %s", task_id, e)
            if handle:
                handle.status = "error"
            await send_notification("task.status", TaskStatus(
                task_id=task_id,
                method=method,
                status="error",
                kind=handle.kind if handle else None,
                cancellable=handle.cancellable if handle else None,
                cancel_requested=handle.cancel_requested if handle else False,
                message=str(e),
            ).model_dump())
            # 执行报错，发送带有错误内容的结果报文
            await send_notification("task.result", TaskResult(
                task_id=task_id, method=method, error=str(e)
            ).model_dump())
        finally:
            # 执行完毕，从活动表清理
            self._tasks.pop(task_id, None)

    def submit_async(
        self,
        method: str,
        coro_factory: Callable[[], Awaitable[Any]],
    ) -> str:
        """
        提交一个异步 I/O 协程任务。
        立即返回生成的 task_id，任务挂起在 asyncio 事件循环后台执行。
        """
        task_id = self._new_id()
        handle = TaskHandle(
            task_id=task_id,
            method=method,
            kind="async",
            cancellable=True,
        )
        self._tasks[task_id] = handle

        coro = self._run_async(task_id, method, coro_factory())
        asyncio_task = asyncio.create_task(coro, name=f"task-{task_id}")
        handle.asyncio_task = asyncio_task

        logger.debug("已提交后台协程任务 %s [%s]", task_id, method)
        return task_id

    def submit_blocking(
        self,
        method: str,
        fn: Callable[[], Any],
    ) -> str:
        """
        提交一个阻塞型或 CPU 密集型任务。
        立即返回生成的 task_id，任务会被指派到线程池中脱离主线程执行。
        """
        task_id = self._new_id()
        handle = TaskHandle(
            task_id=task_id,
            method=method,
            kind="blocking",
            cancellable=False,
        )
        self._tasks[task_id] = handle

        loop = asyncio.get_event_loop()

        async def _wrapper():
            # 将阻塞函数投递到外部共享线程池
            return await loop.run_in_executor(_thread_pool, fn)

        coro = self._run_async(task_id, method, _wrapper())
        asyncio_task = asyncio.create_task(coro, name=f"task-{task_id}")
        handle.asyncio_task = asyncio_task

        logger.debug("已提交线程池阻塞任务 %s [%s]", task_id, method)
        return task_id

    async def cancel(self, task_id: str) -> dict:
        """根据 ID 请求取消任务；线程池阻塞任务无法被强制中断，会返回明确原因。"""
        handle = self._tasks.get(task_id)
        if not handle:
            return TaskCancelResult(
                task_id=task_id,
                cancelled=False,
                reason="task not found",
            ).model_dump()

        handle.cancel_requested = True
        if not handle.cancellable:
            reason = "blocking task cannot be interrupted once it is running"
            await send_notification("task.status", TaskStatus(
                task_id=task_id,
                method=handle.method,
                status=handle.status,
                kind=handle.kind,
                cancellable=handle.cancellable,
                cancel_requested=True,
                message=reason,
            ).model_dump())
            return TaskCancelResult(
                task_id=task_id,
                cancelled=False,
                reason=reason,
            ).model_dump()

        if handle and handle.asyncio_task:
            handle.asyncio_task.cancel()
            return TaskCancelResult(task_id=task_id, cancelled=True).model_dump()

        return TaskCancelResult(
            task_id=task_id,
            cancelled=False,
            reason="task has no cancellable asyncio handle",
        ).model_dump()

    def list_tasks(self) -> list[dict]:
        """返回所有当前活动中的后台任务描述列表。"""
        return [
            TaskSummary(
                task_id=h.task_id,
                method=h.method,
                status=h.status,
                kind=h.kind,
                cancellable=h.cancellable,
                cancel_requested=h.cancel_requested,
            ).model_dump()
            for h in self._tasks.values()
        ]

    async def send_progress(
        self,
        task_id: str,
        progress: float,
        message: Optional[str] = None,
    ) -> None:
        """快捷封装方法：由业务层调用，向 Rust 主动推送某个任务的执行进度报文。"""
        await send_notification("task.progress", TaskProgress(
            task_id=task_id, progress=progress, message=message
        ).model_dump())
