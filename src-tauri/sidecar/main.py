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
from dispatcher import dispatcher

# ─── 导入业务处理器以自动触发 @dispatcher.register 装饰器绑定 ───────────────────
import handlers.echo
import handlers.tasks

registry = TaskRegistry()

async def dispatch(msg: dict) -> None:
    """对流入的 JSON-RPC 消息进行结构验证与分发执行。"""
    jsonrpc = msg.get("jsonrpc")
    if jsonrpc != "2.0":
        logger.warning("丢弃不符合规范的非 JSON-RPC 2.0 报文: %s", msg)
        return

    msg_id = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params")

    try:
        # 使用装饰器派发器调用方法，并将 TaskRegistry 依赖动态注入进去
        result = await dispatcher.call(method, params, registry=registry)
        if msg_id is not None:
            await send_response(msg_id, result)
    except Exception as e:
        logger.exception("执行 RPC 方法 %s 时发生内部异常: %s", method, e)
        if msg_id is not None:
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
    queue: asyncio.Queue[dict] = asyncio.Queue()
    reader_task = asyncio.create_task(stdin_reader(queue), name="stdin-reader")

    logger.info("Sidecar 已进入主轮询事件循环")

    try:
        while True:
            try:
                # 阻塞式从解析队列提取消息并交付给协程分发处理
                msg = await asyncio.wait_for(queue.get(), timeout=1.0)
                asyncio.create_task(dispatch(msg))
            except asyncio.TimeoutError:
                continue  # 定时超时，用于心跳维持及终止状态拦截检查
            except asyncio.CancelledError:
                break
    finally:
        reader_task.cancel()
        logger.info("Sidecar 进程安全退出")


if __name__ == "__main__":
    asyncio.run(main())
