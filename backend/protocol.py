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

from backend.models import RpcError

logger = logging.getLogger(__name__)
JsonRpcId = Union[str, int, None]
MAX_FRAME_BYTES = 4 * 1024 * 1024
MAX_OUTBOUND_QUEUE = 64

# Keep a private protocol stream. backend.main redirects normal print() calls to
# stderr after imports so accidental application output cannot corrupt NDJSON.
_protocol_stdout = sys.stdout.buffer


class OutboundFrameTooLarge(ValueError):
    """Raised before an outbound frame can exceed the shared transport limit."""


WriteItem = tuple[bytes, asyncio.Future[None]]


class ProtocolWriter:
    """Single bounded stdout writer that keeps blocking pipe I/O off the event loop."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[WriteItem | None] = asyncio.Queue(
            maxsize=MAX_OUTBOUND_QUEUE
        )
        self._task = asyncio.create_task(self._run(), name="protocol-stdout-writer")
        self._failure: str | None = None

    async def send(self, frame: bytes) -> None:
        if self._failure is not None:
            raise BrokenPipeError(self._failure)
        completion = asyncio.get_running_loop().create_future()
        await self._queue.put((frame, completion))
        await completion

    async def close(self) -> None:
        await self._queue.put(None)
        await self._task

    @staticmethod
    def _write_sync(frame: bytes) -> None:
        _protocol_stdout.write(frame)
        _protocol_stdout.flush()

    async def _run(self) -> None:
        while True:
            item = await self._queue.get()
            if item is None:
                return
            frame, completion = item
            if self._failure is None:
                try:
                    await asyncio.to_thread(self._write_sync, frame)
                except Exception as error:
                    self._failure = f"protocol stdout writer failed: {error}"
            if completion.done():
                continue
            if self._failure is None:
                completion.set_result(None)
            else:
                completion.set_exception(BrokenPipeError(self._failure))


_writer: ProtocolWriter | None = None


async def start_writer() -> None:
    global _writer
    if _writer is None:
        _writer = ProtocolWriter()


async def stop_writer() -> None:
    global _writer
    writer, _writer = _writer, None
    if writer is not None:
        await writer.close()


async def write_message(obj: dict[str, Any]) -> None:
    """将字典序列化为单行 JSON 并追加换行符写入 stdout。"""
    payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise OutboundFrameTooLarge(
            f"outbound frame is {len(payload)} bytes; limit is {MAX_FRAME_BYTES}"
        )
    if _writer is None:
        raise RuntimeError("protocol stdout writer is not running")
    await _writer.send(payload + b"\n")


async def send_response(id: JsonRpcId, result: Any) -> None:
    """向 Rust 发送成功应答响应报文。"""
    try:
        await write_message({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        })
    except OutboundFrameTooLarge:
        await send_error(
            id,
            -32005,
            "Response too large",
            {"max_bytes": MAX_FRAME_BYTES},
        )


async def send_error(id: JsonRpcId, code: int, message: str, data: Any = None) -> None:
    """向 Rust 发送失败应答响应报文。"""
    error = RpcError(code=code, message=message, data=data).model_dump(exclude_none=True)
    response = {"jsonrpc": "2.0", "id": id, "error": error}
    try:
        await write_message(response)
    except OutboundFrameTooLarge:
        response["error"] = RpcError(
            code=-32005,
            message="Error response too large",
            data={"max_bytes": MAX_FRAME_BYTES},
        ).model_dump(exclude_none=True)
        await write_message(response)


async def send_notification(method: str, params: Any = None) -> None:
    """向 Rust 发送单向异步通知（不带 ID）。"""
    notification: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        if not isinstance(params, (dict, list)):
            raise TypeError("JSON-RPC notification params must be an object or array")
        notification["params"] = params
    try:
        await write_message(notification)
    except OutboundFrameTooLarge as error:
        logger.error("丢弃过大的出站通知 %s: %s", method, error)


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
            line_bytes = await asyncio.to_thread(
                sys.stdin.buffer.readline,
                MAX_FRAME_BYTES + 1,
            )
            if not line_bytes:  # 读到 EOF，代表父进程已被关闭或终止
                logger.info("标准输入流检测到 EOF — 开启安全退出流程")
                break
            if len(line_bytes) > MAX_FRAME_BYTES:
                # Drain the oversized frame to the next newline before resuming,
                # otherwise the remaining chunks would be parsed as new messages.
                while line_bytes and not line_bytes.endswith(b"\n"):
                    line_bytes = await asyncio.to_thread(
                        sys.stdin.buffer.readline,
                        MAX_FRAME_BYTES + 1,
                    )
                logger.warning("丢弃超过 %d 字节的入站报文", MAX_FRAME_BYTES)
                await send_error(None, -32600, "Invalid Request: frame too large")
                continue
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
                logger.warning(
                    "入站消息队列已满（capacity=%d），丢弃消息: %.120r",
                    queue.maxsize,
                    line,
                )
                # JSON-RPC notifications never receive responses, including when
                # the server is overloaded.
                if isinstance(msg, dict) and "id" in msg:
                    await send_error(
                        msg.get("id"),
                        -32000,
                        "Server busy: inbound queue full",
                    )

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("stdin 管道读取异常: %s", e)
            break
