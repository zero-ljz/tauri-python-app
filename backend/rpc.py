from __future__ import annotations

from typing import Any, Callable

from dispatcher import dispatcher
from protocol import send_notification


class RpcServer:
    def register(self, method: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return dispatcher.register(method)

    async def emit(self, event: str, params: Any = None) -> None:
        await send_notification(event, params)

    @property
    def methods(self) -> list[str]:
        return list(dispatcher.handlers.keys())


rpc = RpcServer()
