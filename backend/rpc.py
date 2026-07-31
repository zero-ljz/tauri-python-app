from __future__ import annotations

from collections.abc import Callable
from typing import Any

from backend.dispatcher import NO_PARAMS, RpcMethodSpec, RpcPermission, dispatcher
from backend.protocol import send_notification


class RpcServer:
    def register(
        self,
        method: str,
        *,
        params: Any = NO_PARAMS,
        result: Any = Any,
        permission: RpcPermission = "public",
        description: str | None = None,
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return dispatcher.register(
            method,
            params=params,
            result=result,
            permission=permission,
            description=description,
        )

    async def emit(self, event: str, params: Any = None) -> None:
        await send_notification(event, params)

    @property
    def methods(self) -> list[str]:
        return list(dispatcher.handlers.keys())

    @property
    def specs(self) -> list[RpcMethodSpec]:
        return list(dispatcher.handlers.values())

    @property
    def capabilities(self) -> list[dict[str, str]]:
        return dispatcher.capabilities()


rpc = RpcServer()
