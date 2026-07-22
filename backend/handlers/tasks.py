import asyncio
import time
from backend.rpc import rpc
from backend.task_manager import TaskRegistry
from backend.dispatcher import RpcInvalidParamsError
from backend.models import TaskCancelParams, TaskGetParams
from pydantic import ValidationError


@rpc.register("task.list")
async def handle_task_list(registry: TaskRegistry) -> list[dict]:
    """Return all active tasks."""
    return registry.list_tasks()


def _task_id(params: dict) -> str:
    try:
        return TaskGetParams.model_validate(params).task_id
    except ValidationError as error:
        raise RpcInvalidParamsError("params must contain a non-empty task_id") from error


@rpc.register("task.get")
async def handle_task_get(params: dict, registry: TaskRegistry) -> dict | None:
    """Return the authoritative snapshot for one task."""
    return registry.get_task(_task_id(params))


@rpc.register("task.remove")
async def handle_task_remove(params: dict, registry: TaskRegistry) -> dict:
    """Remove one terminal task from retained history."""
    return registry.remove(_task_id(params))


@rpc.register("task.cancel")
async def handle_task_cancel(params: dict, registry: TaskRegistry) -> dict:
    """Cancel a task by task_id."""
    try:
        validated = TaskCancelParams.model_validate(params)
    except ValidationError as error:
        raise RpcInvalidParamsError("params must contain a non-empty task_id") from error
    return await registry.cancel(validated.task_id)


@rpc.register("task.long")
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


@rpc.register("task.blocking")
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
