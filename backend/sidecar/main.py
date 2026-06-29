from __future__ import annotations

import asyncio
import multiprocessing
from typing import Any

from .protocol import JsonRpcError, JsonRpcWriter, log, parse_json_line
from .runtime import TaskRuntime


async def read_stdin_line() -> str:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, input)


async def serve() -> None:
    writer = JsonRpcWriter()
    await writer.start()
    runtime = TaskRuntime(writer)
    line_tasks: set[asyncio.Task[None]] = set()
    log("info", "sidecar.main", "sidecar started")

    async def handle_line(raw_line: str) -> None:
        request_id: Any | None = None
        try:
            message = parse_json_line(raw_line)
            request_id = message.get("id")
            method = message["method"]
            params = message.get("params")
            if request_id is None:
                await runtime.handle_notification(method, params)
                return
            result = await runtime.handle_request(method, params)
            await writer.result(request_id, result)
        except JsonRpcError as exc:
            if request_id is not None:
                await writer.error(request_id, exc.code, exc.message, exc.data)
            else:
                log("error", "sidecar.protocol", exc.message, code=exc.code, data=exc.data)
        except Exception as exc:
            log("error", "sidecar.protocol", "internal error", error=str(exc))
            if request_id is not None:
                await writer.error(request_id, -32000, "Internal error", {"detail": str(exc)})

    try:
        while True:
            try:
                line = await read_stdin_line()
            except EOFError:
                break
            if not line.strip():
                continue
            task = asyncio.create_task(handle_line(line))
            line_tasks.add(task)
            task.add_done_callback(line_tasks.discard)
    finally:
        log("info", "sidecar.main", "sidecar stopping")
        if line_tasks:
            await asyncio.gather(*line_tasks, return_exceptions=True)
        await runtime.shutdown()


def main() -> None:
    multiprocessing.freeze_support()
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        log("info", "sidecar.main", "sidecar interrupted")
