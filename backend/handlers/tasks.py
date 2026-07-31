import asyncio
import time

from backend.models import (
    TaskCancelParams,
    TaskCancelResult,
    TaskGetParams,
    TaskIdResult,
    TaskRemoveResult,
    TaskSnapshot,
)
from backend.rpc import rpc
from backend.task_manager import TaskRegistry


@rpc.register("task.list", result=list[TaskSnapshot])
async def handle_task_list(registry: TaskRegistry) -> list[dict]:
    """Return all active tasks."""
    return registry.list_tasks()


@rpc.register("task.get", params=TaskGetParams, result=TaskSnapshot | None)
async def handle_task_get(params: TaskGetParams, registry: TaskRegistry) -> dict | None:
    """Return the authoritative snapshot for one task."""
    return registry.get_task(params.task_id)


@rpc.register("task.remove", params=TaskGetParams, result=TaskRemoveResult)
async def handle_task_remove(params: TaskGetParams, registry: TaskRegistry) -> dict:
    """Remove one terminal task from retained history."""
    return registry.remove(params.task_id)


@rpc.register("task.cancel", params=TaskCancelParams, result=TaskCancelResult)
async def handle_task_cancel(params: TaskCancelParams, registry: TaskRegistry) -> dict:
    """Cancel a task by task_id."""
    return await registry.cancel(params.task_id)


@rpc.register("task.long", result=TaskIdResult, permission="debug-only")
async def handle_long_task(registry: TaskRegistry) -> dict:
    """
    Example: spawn a long-running async task.
    Returns task_id immediately; progress notifications are pushed asynchronously.
    """

    async def _work():
        for i in range(1, 6):
            await asyncio.sleep(1)
            await registry.send_progress(task_id, i / 5, f"step {i}/5")
        return {"done": True}

    task_id = registry.submit_async("task.long", _work)
    return {"task_id": task_id}


@rpc.register("task.blocking", result=TaskIdResult, permission="debug-only")
async def handle_blocking_task(registry: TaskRegistry) -> dict:
    """
    Example: spawn a blocking worker thread task.
    The task can be observed, but cannot be force-cancelled once running.
    """

    def _work():
        time.sleep(5)
        return {"done": True, "kind": "blocking"}

    task_id = registry.submit_blocking("task.blocking", _work)
    return {"task_id": task_id}
