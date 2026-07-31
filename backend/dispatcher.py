from __future__ import annotations

import asyncio
import inspect
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import TypeAdapter, ValidationError

logger = logging.getLogger(__name__)

RpcPermission = Literal["public", "debug-only", "requires-confirmation", "dangerous"]
NO_PARAMS = object()


class RpcMethodNotFoundError(ValueError):
    """The requested RPC method is not registered."""


class RpcInvalidParamsError(ValueError):
    """RPC parameters failed method-level validation."""


class RpcPermissionDeniedError(PermissionError):
    """The current runtime is not allowed to call an RPC method."""


class RpcInvalidResultError(RuntimeError):
    """An RPC handler returned data that violates its declared contract."""


def _debug_enabled() -> bool:
    return os.environ.get("TAURI_APP_DEBUG", "").lower() in {"1", "true", "yes"}


@dataclass(frozen=True)
class RpcMethodSpec:
    name: str
    handler: Callable[..., Any]
    params_type: Any = NO_PARAMS
    result_type: Any = Any
    permission: RpcPermission = "public"
    description: str = ""
    params_adapter: TypeAdapter[Any] | None = field(default=None, repr=False)
    result_adapter: TypeAdapter[Any] | None = field(default=None, repr=False)

    def capability(self) -> dict[str, str]:
        return {
            "name": self.name,
            "permission": self.permission,
            "description": self.description,
        }


class RpcDispatcher:
    """Typed RPC registry and dispatcher."""

    def __init__(self) -> None:
        self.handlers: dict[str, RpcMethodSpec] = {}

    def register(
        self,
        name: str,
        *,
        params: Any = NO_PARAMS,
        result: Any = Any,
        permission: RpcPermission = "public",
        description: str | None = None,
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        if permission not in {
            "public",
            "debug-only",
            "requires-confirmation",
            "dangerous",
        }:
            raise ValueError(f"unsupported RPC permission: {permission}")

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            if name in self.handlers:
                raise RuntimeError(f"RPC method {name!r} is already registered")
            spec = RpcMethodSpec(
                name=name,
                handler=func,
                params_type=params,
                result_type=result,
                permission=permission,
                description=description or inspect.getdoc(func) or "",
                params_adapter=None if params is NO_PARAMS else TypeAdapter(params),
                result_adapter=TypeAdapter(result),
            )
            self.handlers[name] = spec
            logger.debug("registered RPC method %s (%s)", name, permission)
            return func

        return decorator

    def capabilities(self) -> list[dict[str, str]]:
        return [spec.capability() for spec in self.handlers.values()]

    @staticmethod
    def _check_permission(spec: RpcMethodSpec) -> None:
        if spec.permission == "debug-only" and not _debug_enabled():
            raise RpcPermissionDeniedError(
                f"RPC method {spec.name!r} is only available in debug builds"
            )

    @staticmethod
    def _validate_params(spec: RpcMethodSpec, params: Any) -> Any:
        if spec.params_type is NO_PARAMS:
            if params is not None:
                raise RpcInvalidParamsError(f"RPC method {spec.name!r} does not accept params")
            return None
        try:
            assert spec.params_adapter is not None
            return spec.params_adapter.validate_python(params)
        except ValidationError as error:
            raise RpcInvalidParamsError(str(error)) from error

    @staticmethod
    def _validate_result(spec: RpcMethodSpec, result: Any) -> Any:
        try:
            assert spec.result_adapter is not None
            validated = spec.result_adapter.validate_python(result)
            return spec.result_adapter.dump_python(validated, mode="json")
        except ValidationError as error:
            raise RpcInvalidResultError(
                f"RPC method {spec.name!r} returned an invalid result: {error}"
            ) from error

    async def call(self, method: str, params: Any, **dependencies: Any) -> Any:
        spec = self.handlers.get(method)
        if spec is None:
            raise RpcMethodNotFoundError(f"RPC method {method!r} is not registered")

        self._check_permission(spec)
        validated_params = self._validate_params(spec, params)
        signature = inspect.signature(spec.handler)
        bound_args: dict[str, Any] = {}
        if "params" in signature.parameters:
            bound_args["params"] = validated_params
        for dependency_name, value in dependencies.items():
            if dependency_name in signature.parameters:
                bound_args[dependency_name] = value

        if inspect.iscoroutinefunction(spec.handler):
            result = await spec.handler(**bound_args)
        else:
            non_params_dependencies = [key for key in bound_args if key != "params"]
            if non_params_dependencies:
                logger.warning(
                    "sync RPC handler %s uses event-loop dependencies %s; running inline",
                    spec.handler.__name__,
                    non_params_dependencies,
                )
                result = spec.handler(**bound_args)
            else:
                result = await asyncio.to_thread(spec.handler, **bound_args)

        return self._validate_result(spec, result)


dispatcher = RpcDispatcher()
