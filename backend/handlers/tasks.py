import asyncio
import time
from backend.rpc import rpc
from backend.task_manager import TaskRegistry
from backend.dispatcher import RpcInvalidParamsError
from backend.models import TaskCancelParams
from pydantic import ValidationError


@rpc.register("task.list")
async def handle_task_list(registry: TaskRegistry) -> list[dict]:
    """Return all active tasks."""
    return registry.list_tasks()


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
