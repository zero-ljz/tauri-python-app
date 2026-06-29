from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any


JSONRPC_VERSION = "2.0"


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class JsonRpcWriter:
    def __init__(self) -> None:
        self._lock = None

    async def start(self) -> None:
        import asyncio

        self._lock = asyncio.Lock()

    async def write(self, message: dict[str, Any]) -> None:
        if self._lock is None:
            raise RuntimeError("JsonRpcWriter.start() must be called before write().")
        payload = json.dumps(message, ensure_ascii=False, separators=(",", ":"))
        async with self._lock:
            sys.stdout.write(payload + "\n")
            sys.stdout.flush()

    async def result(self, request_id: Any, result: Any) -> None:
        await self.write({"jsonrpc": JSONRPC_VERSION, "id": request_id, "result": result})

    async def error(
        self,
        request_id: Any,
        code: int,
        message: str,
        data: Any | None = None,
    ) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        await self.write({"jsonrpc": JSONRPC_VERSION, "id": request_id, "error": error})

    async def notification(self, method: str, params: Any | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": JSONRPC_VERSION, "method": method}
        if params is not None:
            message["params"] = params
        await self.write(message)


def log(level: str, target: str, message: str, **fields: Any) -> None:
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "target": target,
        "message": message,
        **fields,
    }
    sys.stderr.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stderr.flush()


def parse_json_line(line: str) -> dict[str, Any]:
    try:
        message = json.loads(line)
    except json.JSONDecodeError as exc:
        raise JsonRpcError(-32700, "Parse error", {"detail": str(exc)}) from exc
    if not isinstance(message, dict):
        raise JsonRpcError(-32600, "Invalid Request", {"detail": "message must be an object"})
    if message.get("jsonrpc") != JSONRPC_VERSION:
        raise JsonRpcError(-32600, "Invalid Request", {"detail": "jsonrpc must be '2.0'"})
    if "method" not in message or not isinstance(message["method"], str):
        raise JsonRpcError(-32600, "Invalid Request", {"detail": "method is required"})
    return message
