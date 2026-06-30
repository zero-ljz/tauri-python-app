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
from typing import Any, Optional

from models import RpcRequest, RpcResponse, RpcNotification, RpcError

logger = logging.getLogger(__name__)

# 全局 stdout 锁：保证多协程并发写入标准输出时的线程安全，防止报文交错重叠
_stdout_lock = asyncio.Lock()


async def write_message(obj: dict[str, Any]) -> None:
    """将字典序列化为单行 JSON 并追加换行符写入 stdout。"""
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    async with _stdout_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


async def send_response(id: Optional[str], result: Any) -> None:
    """向 Rust 发送成功应答响应报文。"""
    resp = RpcResponse(id=id, result=result)
    await write_message(resp.model_dump(exclude_none=False))


async def send_error(id: Optional[str], code: int, message: str, data: Any = None) -> None:
    """向 Rust 发送失败应答响应报文。"""
    resp = RpcResponse(
        id=id,
        error=RpcError(code=code, message=message, data=data),
    )
    await write_message(resp.model_dump(exclude_none=False))


async def send_notification(method: str, params: Any = None) -> None:
    """向 Rust 发送单向异步通知（不带 ID）。"""
    notif = RpcNotification(method=method, params=params)
    await write_message(notif.model_dump(exclude_none=False))


async def stdin_reader(queue: asyncio.Queue[dict[str, Any]]) -> None:
    """
    流式监听并切分 stdin 管道，将解析合规的 JSON 报文推入接收队列。
    若读到管道关闭事件（EOF）则退出。
    """
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)

    logger.debug("标准输入流读取监听开启")
    while True:
        try:
            line_bytes = await reader.readline()
            if not line_bytes:  # 读到 EOF，代表父进程已被关闭或终止
                logger.info("标准输入流检测到 EOF — 开启安全退出流程")
                break
            line = line_bytes.decode("utf-8").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                await queue.put(msg)
            except json.JSONDecodeError as e:
                logger.warning("丢弃非合规 JSON 报文: %s — 原始报文: %s", e, line)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("stdin 管道读取异常: %s", e)
            break
