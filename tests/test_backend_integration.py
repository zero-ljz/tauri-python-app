from __future__ import annotations

import json
import subprocess
import sys
import time
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class BackendProcess:
    def __init__(self) -> None:
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
            self.ready = self.read()
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
        self.process.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": params,
                }
            )
            + "\n"
        )
        self.process.stdin.flush()
        while True:
            message = self.read()
            if message.get("id") == request_id:
                return message

    def close_stdin(self) -> None:
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()

    def cleanup(self) -> None:
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
        self.assertEqual(self.backend.ready["method"], "backend.ready")
        capabilities = self.backend.ready["params"]["capabilities"]
        self.assertIn("echo", capabilities)

        response = self.backend.request("echo-1", "echo", {"ok": True})
        self.assertEqual(response["result"], {"ok": True})

    def test_structured_errors(self) -> None:
        missing = self.backend.request("missing-1", "missing")
        self.assertEqual(missing["error"]["code"], -32601)

        invalid = self.backend.request("cancel-1", "task.cancel", {})
        self.assertEqual(invalid["error"]["code"], -32602)

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


if __name__ == "__main__":
    unittest.main()
