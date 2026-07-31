# ruff: noqa: E402
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.protocol_config import PROTOCOL_VERSION
from scripts.build_backend import BIN_DIR, executable_name, resolve_target


def main() -> None:
    executable = BIN_DIR / executable_name(resolve_target(None))
    if not executable.is_file():
        raise SystemExit(f"Sidecar does not exist: {executable}")
    messages = [
        {
            "jsonrpc": "2.0",
            "id": "init",
            "method": "initialize",
            "params": {
                "protocol_version": PROTOCOL_VERSION,
                "client": {"name": "sidecar-smoke", "version": "1.0"},
                "capabilities": {},
            },
        },
        {"jsonrpc": "2.0", "method": "initialized"},
        {
            "jsonrpc": "2.0",
            "id": "echo",
            "method": "echo",
            "params": {"source": "packaged-sidecar"},
        },
        {"jsonrpc": "2.0", "id": "shutdown", "method": "backend.shutdown"},
        {"jsonrpc": "2.0", "method": "backend.exit"},
    ]
    stdin = "".join(json.dumps(message, separators=(",", ":")) + "\n" for message in messages)
    env = os.environ.copy()
    env["TAURI_APP_DEBUG"] = "0"
    with tempfile.TemporaryDirectory(prefix="tauri-sidecar-smoke-") as working_directory:
        completed = subprocess.run(
            [str(executable)],
            input=stdin,
            text=True,
            encoding="utf-8",
            capture_output=True,
            cwd=working_directory,
            env=env,
            timeout=15,
            check=False,
        )
    responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    echo = next((response for response in responses if response.get("id") == "echo"), None)
    if (
        completed.returncode != 0
        or echo is None
        or echo.get("result") != {"source": "packaged-sidecar"}
    ):
        raise SystemExit(
            f"Sidecar smoke test failed (exit={completed.returncode})\nstdout={completed.stdout}\nstderr={completed.stderr}"
        )
    print(f"Sidecar smoke test passed: {executable}")


if __name__ == "__main__":
    main()
