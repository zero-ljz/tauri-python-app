from __future__ import annotations

import io
import json
import subprocess
import sys
import time
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class BackendProcess:
    def __init__(self, initialize: bool = True) -> None:
        self.process = subprocess.Popen(
            [sys.executable, "-m", "backend.main"],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        try:
            if initialize:
                self.initialize = self.request(
                    "initialize-1",
                    "initialize",
                    {
                        "protocol_version": "1.0",
                        "client": {"name": "integration-tests", "version": "1.0"},
                        "capabilities": {},
                    },
                )
                self.notify("initialized")
        except BaseException:
            self.cleanup()
            raise

    def read(self) -> dict:
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise AssertionError(f"backend closed stdout unexpectedly: {stderr}")
        return json.loads(line)

    def request(self, request_id: str, method: str, params=None) -> dict:
        assert self.process.stdin is not None
        message = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            message["params"] = params
        self.process.stdin.write(
            json.dumps(message) + "\n"
        )
        self.process.stdin.flush()
        while True:
            message = self.read()
            if message.get("id") == request_id:
                return message

    def notify(self, method: str, params=None) -> None:
        assert self.process.stdin is not None
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def close_stdin(self) -> None:
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()

    def cleanup(self) -> None:
        if self.process.poll() is None and self.process.stdin and not self.process.stdin.closed:
            try:
                self.request("shutdown-1", "backend.shutdown")
                self.notify("backend.exit")
            except (BrokenPipeError, OSError, AssertionError):
                pass
        self.close_stdin()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        if self.process.stdout:
            self.process.stdout.close()
        if self.process.stderr:
            self.process.stderr.close()


class BackendIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = BackendProcess()

    def tearDown(self) -> None:
        self.backend.cleanup()

    def test_ready_and_echo(self) -> None:
        self.assertEqual(self.backend.initialize["result"]["protocol_version"], "1.0")
        capabilities = self.backend.initialize["result"]["capabilities"]["methods"]
        self.assertIn("echo", capabilities)

        response = self.backend.request("echo-1", "echo", {"ok": True})
        self.assertEqual(response["result"], {"ok": True})

    def test_structured_errors(self) -> None:
        missing = self.backend.request("missing-1", "missing")
        self.assertEqual(missing["error"]["code"], -32601)

        invalid = self.backend.request("cancel-1", "task.cancel", {})
        self.assertEqual(invalid["error"]["code"], -32602)

    def test_task_snapshots_are_authoritative(self) -> None:
        response = self.backend.request("blocking-1", "task.blocking")
        task_id = response["result"]["task_id"]
        snapshot = self.backend.request("get-1", "task.get", {"task_id": task_id})
        self.assertEqual(snapshot["result"]["task_id"], task_id)
        self.assertIn(snapshot["result"]["status"], {"queued", "running"})
        listed = self.backend.request("list-1", "task.list")
        self.assertIn(task_id, {task["task_id"] for task in listed["result"]})

    def test_blocking_task_does_not_hold_process_after_parent_eof(self) -> None:
        response = self.backend.request("blocking-1", "task.blocking")
        self.assertIn("task_id", response["result"])

        started = time.monotonic()
        self.backend.close_stdin()
        self.backend.process.wait(timeout=2.5)
        self.assertLess(time.monotonic() - started, 2.5)


class ContractTests(unittest.TestCase):
    def test_generated_method_contract_covers_registered_handlers(self) -> None:
        import backend.handlers.echo  # noqa: F401
        import backend.handlers.tasks  # noqa: F401
        from backend.rpc import rpc
        from scripts.gen_types import RPC_METHODS

        self.assertEqual(set(RPC_METHODS), set(rpc.methods))

    def test_pyinstaller_cross_target_is_rejected(self) -> None:
        from scripts import build_backend

        with mock.patch.object(
            build_backend,
            "rust_host_triple",
            return_value="x86_64-pc-windows-msvc",
        ):
            with self.assertRaisesRegex(RuntimeError, "cannot cross-compile"):
                build_backend.resolve_target("aarch64-apple-darwin")


class SessionProtocolTests(unittest.TestCase):
    def test_application_calls_are_rejected_before_initialize(self) -> None:
        backend = BackendProcess(initialize=False)
        try:
            response = backend.request("echo-before-init", "echo", {"ok": True})
            self.assertEqual(response["error"]["code"], -32002)
        finally:
            backend.cleanup()

    def test_incompatible_protocol_version_is_rejected(self) -> None:
        backend = BackendProcess(initialize=False)
        try:
            response = backend.request(
                "bad-initialize",
                "initialize",
                {
                    "protocol_version": "999.0",
                    "client": {"name": "integration-tests", "version": "1.0"},
                    "capabilities": {},
                },
            )
            self.assertEqual(response["error"]["code"], -32004)
        finally:
            backend.cleanup()


class TaskRegistryTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_tasks_remain_queryable_until_removed(self) -> None:
        from backend.task_manager import TaskRegistry

        registry = TaskRegistry()

        async def work() -> dict:
            return {"ok": True}

        with mock.patch("backend.task_manager.send_notification", new=mock.AsyncMock()):
            task_id = registry.submit_async("task.test", work)
            task = registry._tasks[task_id].asyncio_task
            assert task is not None
            await task

        snapshot = registry.get_task(task_id)
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot["status"], "completed")
        self.assertEqual(snapshot["result"], {"ok": True})
        self.assertTrue(registry.remove(task_id)["removed"])
        self.assertIsNone(registry.get_task(task_id))


class ProtocolWriterTests(unittest.IsolatedAsyncioTestCase):
    async def test_oversized_response_becomes_structured_error(self) -> None:
        from backend import protocol

        original_stdout = protocol._protocol_stdout
        capture = io.BytesIO()
        protocol._protocol_stdout = capture
        try:
            await protocol.start_writer()
            await protocol.send_response("large", "x" * protocol.MAX_FRAME_BYTES)
            await protocol.stop_writer()
        finally:
            if protocol._writer is not None:
                await protocol.stop_writer()
            protocol._protocol_stdout = original_stdout

        frame = capture.getvalue().removesuffix(b"\n")
        self.assertLessEqual(len(frame), protocol.MAX_FRAME_BYTES)
        response = json.loads(frame)
        self.assertEqual(response["id"], "large")
        self.assertEqual(response["error"]["code"], -32005)


if __name__ == "__main__":
    unittest.main()
