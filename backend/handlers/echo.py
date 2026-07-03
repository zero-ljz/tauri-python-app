from typing import Any
from backend.rpc import rpc


@rpc.register("echo")
async def handle_echo(params: Any) -> Any:
    """Return the params as-is."""
    return params
