"""Python sidecar entry point and JSON-RPC session lifecycle."""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import ValidationError

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

logging.basicConfig(
    stream=sys.stderr,
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

from backend.dispatcher import RpcInvalidParamsError, RpcMethodNotFoundError, dispatcher
from backend.models import ImplementationInfo, InitializeParams, InitializeResult
from backend.protocol import (
    send_error,
    send_response,
    start_writer,
    stdin_reader,
    stop_writer,
)
from backend.rpc import rpc
from backend.task_manager import TaskRegistry

import backend.handlers.echo  # noqa: F401, E402
import backend.handlers.tasks  # noqa: F401, E402

# protocol.py retained the original stdout. Everything else logs to stderr.
sys.stdout = sys.stderr

PROTOCOL_VERSION = "1.0"
MAX_INBOUND_QUEUE = 128
MAX_CONCURRENT_DISPATCH = 16


@dataclass
class Session:
    phase: str = "created"
    exit_requested: asyncio.Event = field(default_factory=asyncio.Event)


registry = TaskRegistry()
session = Session()


def response_id(msg: dict[str, Any]) -> str | int | None:
    value = msg.get("id")
    if isinstance(value, bool):
        return None
    return value if isinstance(value, (str, int)) else None


async def _dispatch_control(
    method: str,
    params: Any,
    msg_has_id: bool,
    msg_id: str | int | None,
) -> bool:
    """Handle lifecycle messages and return whether the message was consumed."""
    if method == "initialize":
        if not msg_has_id:
            return True
        if session.phase != "created":
            await send_error(msg_id, -32002, "Backend session is already initialized")
            return True
        try:
            request = InitializeParams.model_validate(params)
        except ValidationError as error:
            await send_error(msg_id, -32602, "Invalid initialize params", error.errors())
            return True
        if request.protocol_version != PROTOCOL_VERSION:
            await send_error(
                msg_id,
                -32004,
                "Unsupported protocol version",
                {"supported": [PROTOCOL_VERSION]},
            )
            return True

        session.phase = "waiting_initialized"
        result = InitializeResult(
            protocol_version=PROTOCOL_VERSION,
            server=ImplementationInfo(
                name="tauri-python-backend",
                version=os.environ.get("TAURI_APP_VERSION", "0.1.0"),
            ),
            capabilities={
                "methods": rpc.methods,
                "tasks": {"query": True, "cancel": True, "remove": True},
            },
        )
        await send_response(msg_id, result.model_dump())
        return True

    if method == "initialized":
        if not msg_has_id and session.phase == "waiting_initialized":
            session.phase = "active"
            logger.info("Backend session initialized")
        return True

    if method == "backend.shutdown":
        if not msg_has_id:
            return True
        if session.phase != "active":
            await send_error(msg_id, -32002, "Backend session is not active")
            return True
        session.phase = "shutting_down"
        await registry.shutdown()
        await send_response(msg_id, None)
        return True

    if method == "backend.exit":
        if not msg_has_id and session.phase == "shutting_down":
            session.exit_requested.set()
        return True

    return False


async def dispatch(msg: Any) -> None:
    """Validate and dispatch one JSON-RPC 2.0 message."""
    if not isinstance(msg, dict):
        await send_error(None, -32600, "Invalid Request")
        return

    msg_has_id = "id" in msg
    msg_id = response_id(msg)
    if msg.get("jsonrpc") != "2.0":
        await send_error(msg_id, -32600, "Invalid Request")
        return
    if msg_has_id and msg.get("id") is not None and msg_id is None:
        await send_error(None, -32600, "Invalid Request")
        return

    method = msg.get("method")
    if not isinstance(method, str) or not method:
        if msg_has_id:
            await send_error(msg_id, -32600, "Invalid Request")
        return

    params = msg.get("params")
    if "params" in msg and not isinstance(params, (dict, list)):
        if msg_has_id:
            await send_error(msg_id, -32602, "params must be an object or array")
        return

    if await _dispatch_control(method, params, msg_has_id, msg_id):
        return
    if session.phase != "active":
        if msg_has_id:
            await send_error(msg_id, -32002, "Backend session is not initialized")
        return

    try:
        result = await dispatcher.call(method, params, registry=registry)
        if msg_has_id:
            await send_response(msg_id, result)
    except RpcMethodNotFoundError as error:
        if msg_has_id:
            await send_error(msg_id, -32601, str(error))
    except RpcInvalidParamsError as error:
        if msg_has_id:
            await send_error(msg_id, -32602, str(error))
    except Exception:
        logger.exception("执行 RPC 方法 %s 时发生内部异常", method)
        if msg_has_id:
            await send_error(msg_id, -32603, "Internal error")


async def main() -> None:
    logger.info("Backend process started; waiting for initialize")
    await start_writer()
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=MAX_INBOUND_QUEUE)
    dispatch_slots = asyncio.Semaphore(MAX_CONCURRENT_DISPATCH)
    active_dispatch_tasks: set[asyncio.Task] = set()
    reader_task = asyncio.create_task(stdin_reader(queue), name="stdin-reader")

    async def run_dispatch_with_slot(message: Any) -> None:
        try:
            await dispatch(message)
        finally:
            dispatch_slots.release()

    def track(task: asyncio.Task) -> None:
        active_dispatch_tasks.add(task)

        def cleanup(done: asyncio.Task) -> None:
            active_dispatch_tasks.discard(done)
            try:
                error = done.exception()
            except asyncio.CancelledError:
                return
            if error:
                logger.error("RPC dispatch task failed: %s", error)

        task.add_done_callback(cleanup)

    try:
        while not session.exit_requested.is_set():
            try:
                message = await asyncio.wait_for(queue.get(), timeout=0.25)
            except asyncio.TimeoutError:
                if reader_task.done():
                    break
                continue

            method = message.get("method") if isinstance(message, dict) else None
            if method in {"initialize", "initialized", "backend.shutdown", "backend.exit"}:
                await dispatch(message)
                continue

            await dispatch_slots.acquire()
            track(asyncio.create_task(run_dispatch_with_slot(message), name="rpc-dispatch"))
    finally:
        reader_task.cancel()
        for task in active_dispatch_tasks:
            task.cancel()
        if active_dispatch_tasks:
            await asyncio.gather(*active_dispatch_tasks, return_exceptions=True)
        await registry.shutdown()
        await stop_writer()
        logger.info("Backend process exited")


if __name__ == "__main__":
    asyncio.run(main())
    sys.stderr.flush()
    # Running worker threads cannot be interrupted; the sidecar process must not
    # outlive its supervising Tauri process after EOF or a graceful exit.
    os._exit(0)
