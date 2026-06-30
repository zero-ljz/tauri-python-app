import inspect
import asyncio
import logging
from typing import Callable, Any, Dict

logger = logging.getLogger(__name__)

class RpcMethodNotFoundError(ValueError):
    """JSON-RPC 方法未注册错误。"""
    pass


class RpcDispatcher:
    """
    基于装饰器模式的 RPC 方法注册与动态分派处理器。
    """
    def __init__(self) -> None:
        # 路由表字典，映射 "方法名" -> "可执行处理函数"
        self.handlers: Dict[str, Callable[..., Any]] = {}

    def register(self, name: str):
        """
        用于在业务处理函数上声明注册的装饰器方法。
        使用示例：
            @dispatcher.register("my.method")
            def my_method(params):
                ...
        """
        def decorator(func: Callable[..., Any]):
            self.handlers[name] = func
            logger.debug("已注册 RPC 接口方法: %r 映射至 -> %s()", name, func.__name__)
            return func
        return decorator

    async def call(self, method: str, params: Any, **dependencies) -> Any:
        """
        根据注册的方法名，动态匹配依赖并反射调用底层函数，兼容同步与异步协程。
        """
        if method not in self.handlers:
            raise RpcMethodNotFoundError(f"RPC 方法 {method!r} 未在 Sidecar 路由表中注册")

        handler = self.handlers[method]
        sig = inspect.signature(handler)
        
        # 通过方法签名匹配检查，动态组装调用入参（依赖注入）
        bound_args = {}
        if "params" in sig.parameters:
            bound_args["params"] = params
            
        for name, value in dependencies.items():
            if name in sig.parameters:
                bound_args[name] = value

        # 判断并兼容同步普通函数与 asyncio 异步协程函数
        if inspect.iscoroutinefunction(handler):
            return await handler(**bound_args)
        else:
            return await asyncio.to_thread(handler, **bound_args)

# 全局共享的 RPC 调度派发器单例
dispatcher = RpcDispatcher()
