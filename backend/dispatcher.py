import inspect
import asyncio
import logging
from typing import Callable, Any, Dict

logger = logging.getLogger(__name__)

class RpcMethodNotFoundError(ValueError):
    """JSON-RPC 方法未注册错误。"""
    pass


class RpcInvalidParamsError(ValueError):
    """RPC parameters failed method-level validation."""

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
            if name in self.handlers:
                raise RuntimeError(f"RPC 方法 {name!r} 被重复注册")
            self.handlers[name] = func
            logger.debug("已注册 RPC 接口方法: %r 映射至 -> %s()", name, func.__name__)
            return func
        return decorator

    async def call(self, method: str, params: Any, **dependencies) -> Any:
        """
        根据注册的方法名，动态匹配依赖并反射调用底层函数，兼容同步与异步协程。

        Fix 5：对同步 handler 进行安全性检查。
        - 异步 handler（async def）：可安全接收任意依赖（包括 TaskRegistry）。
        - 同步 handler（def）：通过 asyncio.to_thread 在线程池执行，
          若接收非线程安全的依赖（如 TaskRegistry），会产生并发安全问题。
          此时记录警告并在当前事件循环直接调用（不 to_thread），
          同时建议将 handler 改为 async def。
        """
        if method not in self.handlers:
            raise RpcMethodNotFoundError(f"RPC 方法 {method!r} 未在 Backend 路由表中注册")

        handler = self.handlers[method]
        sig = inspect.signature(handler)

        # 通过方法签名匹配检查，动态组装调用入参（依赖注入）
        bound_args = {}
        if "params" in sig.parameters:
            bound_args["params"] = params

        for dep_name, value in dependencies.items():
            if dep_name in sig.parameters:
                bound_args[dep_name] = value

        # 判断并兼容同步普通函数与 asyncio 异步协程函数
        if inspect.iscoroutinefunction(handler):
            return await handler(**bound_args)
        else:
            # Fix 5：检测同步 handler 是否注入了非 params 的依赖（通常非线程安全）
            non_params_deps = [k for k in bound_args if k != "params"]
            if non_params_deps:
                logger.warning(
                    "同步 handler %r 接收了依赖参数 %s，这些依赖可能非线程安全。"
                    "将在事件循环主线程直接调用（跳过 to_thread）以避免并发问题。"
                    "建议将此 handler 改写为 async def 以安全使用依赖注入。",
                    handler.__name__,
                    non_params_deps,
                )
                # 在当前事件循环直接执行，避免将非线程安全对象暴露给线程池
                return handler(**bound_args)

            # 无非线程安全依赖的同步 handler，正常投入线程池执行
            return await asyncio.to_thread(handler, **bound_args)


# 全局共享的 RPC 调度派发器单例
dispatcher = RpcDispatcher()
