from dispatcher import dispatcher

@dispatcher.register("echo")
async def handle_echo(params: any) -> any:
    """Return the params as-is."""
    return params
