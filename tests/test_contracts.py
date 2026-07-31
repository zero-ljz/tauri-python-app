from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock

from pydantic import BaseModel

from backend.dispatcher import (
    RpcDispatcher,
    RpcInvalidParamsError,
    RpcInvalidResultError,
    RpcPermissionDeniedError,
)
from backend.protocol_config import MAX_FRAME_BYTES, PROTOCOL_VERSION
from backend.redaction import redact_text, redact_value

ROOT = Path(__file__).resolve().parents[1]


class InputModel(BaseModel):
    value: int


class OutputModel(BaseModel):
    doubled: int


class TypedRpcContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_params_and_results_are_validated_from_registration_metadata(self) -> None:
        dispatcher = RpcDispatcher()

        @dispatcher.register("double", params=InputModel, result=OutputModel)
        async def double(params: InputModel) -> dict[str, int]:
            return {"doubled": params.value * 2}

        self.assertEqual(await dispatcher.call("double", {"value": 3}), {"doubled": 6})
        with self.assertRaises(RpcInvalidParamsError):
            await dispatcher.call("double", {"value": "not-an-int"})

    async def test_invalid_handler_results_fail_closed(self) -> None:
        dispatcher = RpcDispatcher()

        @dispatcher.register("broken", result=OutputModel)
        async def broken() -> dict[str, str]:
            return {"doubled": "invalid"}

        with self.assertRaises(RpcInvalidResultError):
            await dispatcher.call("broken", None)

    async def test_debug_methods_are_disabled_in_release_runtime(self) -> None:
        dispatcher = RpcDispatcher()

        @dispatcher.register("debug.sample", permission="debug-only")
        async def debug_sample() -> None:
            return None

        with mock.patch.dict(os.environ, {"TAURI_APP_DEBUG": "0"}):
            with self.assertRaises(RpcPermissionDeniedError):
                await dispatcher.call("debug.sample", None)


class ProtocolManifestTests(unittest.TestCase):
    def test_generated_protocol_constants_match_manifest(self) -> None:
        manifest = json.loads((ROOT / "protocol.json").read_text(encoding="utf-8"))
        self.assertEqual(PROTOCOL_VERSION, manifest["version"])
        self.assertEqual(MAX_FRAME_BYTES, manifest["max_frame_bytes"])
        rust = (ROOT / "src-tauri" / "src" / "protocol_config.rs").read_text(encoding="utf-8")
        typescript = (ROOT / "src" / "types" / "protocol.ts").read_text(encoding="utf-8")
        self.assertIn(f"MAX_FRAME_BYTES: usize = {MAX_FRAME_BYTES}", rust)
        self.assertIn(f"MAX_FRAME_BYTES = {MAX_FRAME_BYTES}", typescript)

    def test_redaction_removes_structured_and_inline_credentials(self) -> None:
        value = redact_value({"apiToken": "abc", "nested": {"name": "safe"}})
        self.assertEqual(value, {"apiToken": "[REDACTED]", "nested": {"name": "safe"}})
        self.assertNotIn("secret", redact_text("password=secret"))

    def test_updater_plugin_has_an_inert_object_configuration(self) -> None:
        tauri_config = json.loads(
            (ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
        )
        updater = tauri_config.get("plugins", {}).get("updater")
        self.assertIsInstance(updater, dict)
        self.assertEqual(updater.get("pubkey"), "")
        self.assertEqual(updater.get("endpoints"), [])


if __name__ == "__main__":
    unittest.main()
