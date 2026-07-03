from typing import Any
from dispatcher import dispatcher

@dispatcher.register("echo")
async def handle_echo(params: Any) -> Any:
    """Return the params as-is."""
    return params
