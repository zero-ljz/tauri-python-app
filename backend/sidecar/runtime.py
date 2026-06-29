from __future__ import annotations

import asyncio
import multiprocessing
import os
import platform
import sys
import time
import uuid
from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from pydantic import ValidationError

from .protocol import JsonRpcError, JsonRpcWriter, log
from .schemas import (
    AsyncSleepPayload,
    BlockingIoPayload,
    CpuCountPayload,
    SystemInfoResult,
    TaskCancelParams,
    TaskCancelResult,
    TaskCatalogResult,
    TaskDescriptor,
    TaskKind,
    TaskStartParams,
    TaskStartResult,
    TaskState,
    TaskStatusParams,
    TaskStatusResult,
)

ProgressCallback = Callable[[float, str], Awaitable[None]]
AsyncHandler = Callable[[dict[str, Any], ProgressCallback], Awaitable[Any]]
ExecutorHandler = Callable[[dict[str, Any]], Any]


@dataclass(frozen=True)
class TaskDefinition:
    name: str
    title: str
    kind: TaskKind
    description: str
    payload_model: type[AsyncSleepPayload] | type[BlockingIoPayload] | type[CpuCountPayload]
    handler: AsyncHandler | ExecutorHandler

    def descriptor(self) -> TaskDescriptor:
        return TaskDescriptor(
            name=self.name,
            title=self.title,
            kind=self.kind,
            description=self.description,
            default_payload=self.payload_model().model_dump(mode="json"),
        )


@dataclass
class TaskHandle:
    task_id: str
    definition: TaskDefinition
    state: TaskState = "queued"
    progress: float = 0.0
    message: str | None = None
    result: Any | None = None
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    task: asyncio.Task[None] | None = None
    worker_future: Future[Any] | None = None

    def status(self) -> TaskStatusResult:
        return TaskStatusResult(
            task_id=self.task_id,
            task_name=self.definition.name,
            kind=self.definition.kind,
            state=self.state,
            progress=self.progress,
            message=self.message,
            result=self.result,
            error=self.error,
            started_at=self.started_at,
            finished_at=self.finished_at,
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def async_sleep_task(payload: dict[str, Any], progress: ProgressCallback) -> dict[str, Any]:
    params = AsyncSleepPayload.model_validate(payload)
    step_sleep = params.duration_ms / params.steps / 1000
    for step in range(params.steps):
        await asyncio.sleep(step_sleep)
        await progress((step + 1) / params.steps, f"async tick {step + 1}/{params.steps}")
    return {"slept_ms": params.duration_ms, "steps": params.steps}


def blocking_io_task(payload: dict[str, Any]) -> dict[str, Any]:
    params = BlockingIoPayload.model_validate(payload)
    time.sleep(params.duration_ms / 1000)
    return {"slept_ms": params.duration_ms, "threaded": True}


def cpu_count_primes_task(payload: dict[str, Any]) -> dict[str, Any]:
    params = CpuCountPayload.model_validate(payload)
    count = 0
    for value in range(2, params.limit + 1):
        is_prime = True
        divisor = 2
        while divisor * divisor <= value:
            if value % divisor == 0:
                is_prime = False
                break
            divisor += 1
        if is_prime:
            count += 1
    return {"limit": params.limit, "prime_count": count}


TASK_DEFINITIONS: dict[str, TaskDefinition] = {
    "demo.async_sleep": TaskDefinition(
        name="demo.async_sleep",
        title="Async I/O task",
        kind="async_io",
        description="Runs on the asyncio event loop and streams progress.",
        payload_model=AsyncSleepPayload,
        handler=async_sleep_task,
    ),
    "demo.blocking_io": TaskDefinition(
        name="demo.blocking_io",
        title="Blocking I/O task",
        kind="blocking_io",
        description="Runs in ThreadPoolExecutor for blocking work or GIL-releasing libraries.",
        payload_model=BlockingIoPayload,
        handler=blocking_io_task,
    ),
    "demo.cpu_count_primes": TaskDefinition(
        name="demo.cpu_count_primes",
        title="CPU-bound task",
        kind="cpu_bound",
        description="Runs in ProcessPoolExecutor for CPU-heavy work.",
        payload_model=CpuCountPayload,
        handler=cpu_count_primes_task,
    ),
}


class TaskRuntime:
    def __init__(self, writer: JsonRpcWriter) -> None:
        self._writer = writer
        self._tasks: dict[str, TaskHandle] = {}
        self._lock = asyncio.Lock()
        self._thread_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sidecar-io")
        self._process_pool: ProcessPoolExecutor | None = None
        self._process_context = multiprocessing.get_context("spawn")

    async def shutdown(self) -> None:
        async with self._lock:
            handles = list(self._tasks.values())
        for handle in handles:
            if handle.task and not handle.task.done():
                handle.task.cancel()
        await asyncio.gather(
            *(handle.task for handle in handles if handle.task is not None),
            return_exceptions=True,
        )
        self._thread_pool.shutdown(wait=False, cancel_futures=True)
        if self._process_pool is not None:
            self._process_pool.shutdown(wait=False, cancel_futures=True)

    async def handle_request(self, method: str, params: Any | None) -> Any:
        if method == "system.ping":
            return SystemInfoResult(
                pid=os.getpid(),
                python_version=sys.version.split()[0],
                platform=platform.platform(),
            ).model_dump(mode="json")
        if method == "task.catalog":
            return TaskCatalogResult(
                tasks=[definition.descriptor() for definition in TASK_DEFINITIONS.values()]
            ).model_dump(mode="json")
        if method == "task.start":
            return (await self.start_task(params)).model_dump(mode="json")
        if method == "task.cancel":
            return (await self.cancel_task(params)).model_dump(mode="json")
        if method == "task.status":
            return (await self.task_status(params)).model_dump(mode="json")
        if method == "system.shutdown":
            asyncio.create_task(self.shutdown())
            return {"accepted": True}
        raise JsonRpcError(-32601, "Method not found", {"method": method})

    async def handle_notification(self, method: str, params: Any | None) -> None:
        if method == "task.cancel":
            await self.cancel_task(params)
            return
        log("info", "sidecar.notification", "ignored notification", method=method, params=params)

    async def start_task(self, raw_params: Any | None) -> TaskStartResult:
        params = self._validate(TaskStartParams, raw_params or {})
        definition = TASK_DEFINITIONS.get(params.task_name)
        if definition is None:
            raise JsonRpcError(-32602, "Unknown task", {"task_name": params.task_name})

        payload = self._validate(definition.payload_model, params.payload).model_dump(mode="json")
        task_id = f"task_{uuid.uuid4().hex[:12]}"
        handle = TaskHandle(task_id=task_id, definition=definition)

        async with self._lock:
            self._tasks[task_id] = handle

        handle.task = asyncio.create_task(self._run_task(handle, payload))
        return TaskStartResult(
            task_id=task_id,
            task_name=definition.name,
            state=handle.state,
            accepted_at=utc_now(),
        )

    async def cancel_task(self, raw_params: Any | None) -> TaskCancelResult:
        params = self._validate(TaskCancelParams, raw_params or {})
        handle = await self._get_handle(params.task_id)
        if handle.state in ("completed", "failed", "cancelled"):
            return TaskCancelResult(task_id=handle.task_id, accepted=False, state=handle.state)
        handle.state = "cancelling"
        handle.message = "cancellation requested"
        await self._publish("task.progress", handle)
        if handle.worker_future is not None:
            handle.worker_future.cancel()
        if handle.task is not None:
            handle.task.cancel()
        return TaskCancelResult(task_id=handle.task_id, accepted=True, state=handle.state)

    async def task_status(self, raw_params: Any | None) -> TaskStatusResult:
        params = self._validate(TaskStatusParams, raw_params or {})
        return (await self._get_handle(params.task_id)).status()

    async def _run_task(self, handle: TaskHandle, payload: dict[str, Any]) -> None:
        handle.state = "running"
        handle.started_at = utc_now()
        handle.message = "started"
        await self._publish("task.started", handle)
        try:
            if handle.definition.kind == "async_io":
                result = await self._run_async(handle, payload)
            elif handle.definition.kind == "blocking_io":
                result = await self._run_executor(handle, payload, self._thread_pool)
            else:
                result = await self._run_executor(
                    handle,
                    payload,
                    self._get_process_pool(),
                    timeout_ms=CpuCountPayload.model_validate(payload).timeout_ms,
                )

            handle.state = "completed"
            handle.progress = 1.0
            handle.result = result
            handle.message = "completed"
            handle.finished_at = utc_now()
            await self._publish("task.completed", handle)
        except asyncio.CancelledError:
            handle.state = "cancelled"
            handle.finished_at = utc_now()
            handle.message = "cancelled"
            await self._publish("task.cancelled", handle)
        except Exception as exc:
            handle.state = "failed"
            handle.error = str(exc)
            handle.finished_at = utc_now()
            handle.message = "failed"
            log("error", "sidecar.task", "task failed", task_id=handle.task_id, error=str(exc))
            await self._publish("task.failed", handle)

    async def _run_async(self, handle: TaskHandle, payload: dict[str, Any]) -> Any:
        async def progress(value: float, message: str) -> None:
            handle.progress = max(0.0, min(value, 1.0))
            handle.message = message
            await self._publish("task.progress", handle)

        return await handle.definition.handler(payload, progress)  # type: ignore[misc]

    async def _run_executor(
        self,
        handle: TaskHandle,
        payload: dict[str, Any],
        executor: ThreadPoolExecutor | ProcessPoolExecutor,
        timeout_ms: int | None = None,
    ) -> Any:
        loop = asyncio.get_running_loop()
        handle.progress = 0.05
        handle.message = f"submitted to {handle.definition.kind} executor"
        await self._publish("task.progress", handle)
        handle.worker_future = loop.run_in_executor(
            executor,
            handle.definition.handler,  # type: ignore[arg-type]
            payload,
        )
        if timeout_ms is None:
            result = await handle.worker_future
        else:
            try:
                result = await asyncio.wait_for(handle.worker_future, timeout=timeout_ms / 1000)
            except asyncio.TimeoutError as exc:
                handle.worker_future.cancel()
                raise TimeoutError(
                    f"{handle.definition.kind} executor timed out after {timeout_ms} ms"
                ) from exc
        handle.progress = 0.95
        handle.message = "executor result received"
        await self._publish("task.progress", handle)
        return result

    def _get_process_pool(self) -> ProcessPoolExecutor:
        if self._process_pool is None:
            self._process_pool = ProcessPoolExecutor(
                max_workers=max(1, min(os.cpu_count() or 1, 4)),
                mp_context=self._process_context,
            )
        return self._process_pool

    async def _publish(self, method: str, handle: TaskHandle) -> None:
        await self._writer.notification(method, handle.status().model_dump(mode="json"))

    async def _get_handle(self, task_id: str) -> TaskHandle:
        async with self._lock:
            handle = self._tasks.get(task_id)
        if handle is None:
            raise JsonRpcError(-32602, "Unknown task", {"task_id": task_id})
        return handle

    def _validate(self, model: Any, raw: Any) -> Any:
        try:
            return model.model_validate(raw)
        except ValidationError as exc:
            raise JsonRpcError(-32602, "Invalid params", exc.errors()) from exc
