"""
基于 NDJSON (换行符分隔的 JSON) 的 JSON-RPC 2.0 通信底座协议层。
- 读取 stdin 行事件流。
- 通过 asyncio.Lock 全局排他锁向 stdout 串行输出 NDJSON。
- stderr 管道只负责日志记录。
"""
from __future__ import annotations
import asyncio
import json
import sys
import logging
from typing import Any, Union

from backend.models import RpcNotification, RpcError

logger = logging.getLogger(__name__)
JsonRpcId = Union[str, int, None]

# 全局 stdout 锁：保证多协程并发写入标准输出时的线程安全，防止报文交错重叠
_stdout_lock = asyncio.Lock()


async def write_message(obj: dict[str, Any]) -> None:
    """将字典序列化为单行 JSON 并追加换行符写入 stdout。"""
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    async with _stdout_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


async def send_response(id: JsonRpcId, result: Any) -> None:
    """向 Rust 发送成功应答响应报文。"""
    await write_message({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })


async def send_error(id: JsonRpcId, code: int, message: str, data: Any = None) -> None:
    """向 Rust 发送失败应答响应报文。"""
    error = RpcError(code=code, message=message, data=data).model_dump(exclude_none=True)
    await write_message({
        "jsonrpc": "2.0",
        "id": id,
        "error": error,
    })


async def send_notification(method: str, params: Any = None) -> None:
    """向 Rust 发送单向异步通知（不带 ID）。"""
    notif = RpcNotification(method=method, params=params)
    await write_message(notif.model_dump(exclude_none=False))


async def stdin_reader(queue: asyncio.Queue[dict[str, Any]]) -> None:
    """
    流式监听并切分 stdin 管道，将解析合规的 JSON 报文推入接收队列。
    若读到管道关闭事件（EOF）则退出。

    Fix 7：队列满时改为丢弃并返回背压错误，而非无限阻塞 stdin 读取协程。
    当 stdin_reader 被阻塞时，Rust 端的 stdin 写入会因管道缓冲区满而反压，
    最终导致 RPC 请求超时——现在通过主动丢弃并上报错误来避免这一死锁。
    """
    logger.debug("标准输入流读取监听开启")
    while True:
        try:
            # Windows 的 ProactorEventLoop 对标准输入管道支持不稳定，使用线程读取
            # 可以避开 connect_read_pipe 在 PyInstaller/管道环境中的 WinError 6。
            line_bytes = await asyncio.to_thread(sys.stdin.buffer.readline)
            if not line_bytes:  # 读到 EOF，代表父进程已被关闭或终止
                logger.info("标准输入流检测到 EOF — 开启安全退出流程")
                break
            try:
                line = line_bytes.decode("utf-8").strip()
            except UnicodeDecodeError as e:
                logger.warning("丢弃非 UTF-8 编码报文: %s", e)
                continue
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                logger.warning("丢弃非合规 JSON 报文: %s — 原始报文: %s", e, line)
                await send_error(None, -32700, "Parse error")
                continue

            # Fix 7：尝试非阻塞入队；队列满时丢弃并返回背压错误，
            # 防止 stdin_reader 协程永久挂起导致管道死锁。
            try:
                queue.put_nowait(msg)
            except asyncio.QueueFull:
                msg_id = msg.get("id") if isinstance(msg, dict) else None
                logger.warning(
                    "入站消息队列已满（capacity=%d），丢弃消息: %.120r",
                    queue.maxsize,
                    line,
                )
                await send_error(msg_id, -32000, "Server busy: inbound queue full")

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("stdin 管道读取异常: %s", e)
            break
