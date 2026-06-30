"""
Python Sidecar 主入口程序。
- 初始化 asyncio 事件循环
- 启动标准输入按行读取任务 -> 路由分发消息
- 启动时向 Rust 侧推送 sidecar.ready 就绪通知
"""
from __future__ import annotations
import asyncio
import logging
import sys
from typing import Any

# Windows/PyInstaller 环境默认编码可能不是 UTF-8；显式固定协议与日志编码。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)

# 配置标准错误输出流专属的格式化日志（保证标准输出 stdout 只承载协议 JSON 报文）
logging.basicConfig(
    stream=sys.stderr,
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

from protocol import stdin_reader, send_response, send_error, send_notification
from task_manager import TaskRegistry
from models import SidecarReadyPayload
from dispatcher import dispatcher, RpcMethodNotFoundError

# ─── 导入业务处理器以自动触发 @dispatcher.register 装饰器绑定 ───────────────────
import handlers.echo
import handlers.tasks

registry = TaskRegistry()
MAX_INBOUND_QUEUE = 128
MAX_CONCURRENT_DISPATCH = 16

def response_id(msg: dict[str, Any]) -> str | int | None:
    """Return a JSON-RPC response id, or null when the id is absent/invalid."""
    value = msg.get("id")
    return value if isinstance(value, (str, int)) else None


async def dispatch(msg: Any) -> None:
    """对流入的 JSON-RPC 消息进行结构验证与分发执行。"""
    if not isinstance(msg, dict):
        logger.warning("收到非对象 JSON-RPC 报文: %s", msg)
        await send_error(None, -32600, "Invalid Request")
        return

    msg_has_id = "id" in msg
    msg_id = response_id(msg)
    jsonrpc = msg.get("jsonrpc")
    if jsonrpc != "2.0":
        logger.warning("收到不符合规范的非 JSON-RPC 2.0 报文: %s", msg)
        await send_error(msg_id, -32600, "Invalid Request")
        return

    method = msg.get("method")
    if not isinstance(method, str) or not method:
        logger.warning("收到缺少有效 method 的 JSON-RPC 报文: %s", msg)
        if msg_has_id:
            await send_error(msg_id, -32600, "Invalid Request")
        return

    params = msg.get("params")

    try:
        # 使用装饰器派发器调用方法，并将 TaskRegistry 依赖动态注入进去
        result = await dispatcher.call(method, params, registry=registry)
        if msg_has_id:
            await send_response(msg_id, result)
    except RpcMethodNotFoundError as e:
        logger.warning("执行 RPC 方法 %s 时未找到处理器: %s", method, e)
        if msg_has_id:
            await send_error(msg_id, -32601, str(e))
    except Exception as e:
        logger.exception("执行 RPC 方法 %s 时发生内部异常: %s", method, e)
        if msg_has_id:
            await send_error(msg_id, -32603, str(e))


# ─── 主异步工作循环 ───────────────────────────────────────────────────────────

async def main() -> None:
    logger.info("Sidecar 脚本初始化...")

    # 向 Rust 广播就绪通知，携带当前已装载的所有 RPC 方法清单作为能力表
    await send_notification(
        "sidecar.ready",
        SidecarReadyPayload(
            version="0.1.0",
            capabilities=list(dispatcher.handlers.keys()),
        ).model_dump(),
    )

    # 启动后台 stdin 协程异步读取管道行流
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=MAX_INBOUND_QUEUE)
    dispatch_slots = asyncio.Semaphore(MAX_CONCURRENT_DISPATCH)
    active_dispatch_tasks: set[asyncio.Task] = set()
    reader_task = asyncio.create_task(stdin_reader(queue), name="stdin-reader")

    logger.info("Sidecar 已进入主轮询事件循环")

    async def run_dispatch_with_slot(msg: Any) -> None:
        try:
            await dispatch(msg)
        finally:
            dispatch_slots.release()

    def track_dispatch_task(task: asyncio.Task) -> None:
        active_dispatch_tasks.add(task)

        def cleanup(done: asyncio.Task) -> None:
            active_dispatch_tasks.discard(done)
            try:
                exc = done.exception()
            except asyncio.CancelledError:
                return
            if exc:
                logger.exception("RPC 调度任务未捕获异常: %s", exc)

        task.add_done_callback(cleanup)

    try:
        while True:
            try:
                # 阻塞式从解析队列提取消息并交付给协程分发处理
                msg = await asyncio.wait_for(queue.get(), timeout=1.0)
                await dispatch_slots.acquire()
                task = asyncio.create_task(run_dispatch_with_slot(msg), name="rpc-dispatch")
                track_dispatch_task(task)
            except asyncio.TimeoutError:
                if reader_task.done():
                    exc = reader_task.exception()
                    if exc:
                        logger.error("stdin 读取任务异常退出: %s", exc)
                    break
                continue  # 定时超时，用于心跳维持及终止状态拦截检查
            except asyncio.CancelledError:
                break
    finally:
        reader_task.cancel()
        for task in active_dispatch_tasks:
            task.cancel()
        if active_dispatch_tasks:
            await asyncio.gather(*active_dispatch_tasks, return_exceptions=True)
        logger.info("Sidecar 进程安全退出")


if __name__ == "__main__":
    asyncio.run(main())
