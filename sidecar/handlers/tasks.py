import asyncio
import time
from dispatcher import dispatcher
from task_manager import TaskRegistry

@dispatcher.register("task.list")
async def handle_task_list(registry: TaskRegistry) -> list[dict]:
    """Return all active tasks."""
    return registry.list_tasks()

@dispatcher.register("task.cancel")
async def handle_task_cancel(params: dict, registry: TaskRegistry) -> dict:
    """Cancel a task by task_id."""
    if not isinstance(params, dict) or "task_id" not in params:
        raise ValueError("params must have 'task_id'")
    task_id = params["task_id"]
    return await registry.cancel(task_id)

@dispatcher.register("task.long")
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

@dispatcher.register("task.blocking")
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
