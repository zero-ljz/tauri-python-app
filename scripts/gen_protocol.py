from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:
    from ._python_env import reexec_with_local_venv
except ImportError:
    from _python_env import reexec_with_local_venv


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "protocol.json"
PYTHON_OUTPUT = ROOT / "backend" / "protocol_config.py"
RUST_OUTPUT = ROOT / "src-tauri" / "src" / "protocol_config.rs"
TYPESCRIPT_OUTPUT = ROOT / "src" / "types" / "protocol.ts"

INTEGER_KEYS = (
    "max_frame_bytes",
    "max_log_line_bytes",
    "max_inbound_queue",
    "max_outbound_queue",
    "max_concurrent_dispatch",
    "max_task_history",
    "max_frontend_rpc_entries",
    "max_frontend_logs",
)


def load_manifest() -> dict[str, Any]:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not isinstance(version, str) or not version:
        raise ValueError("protocol.json version must be a non-empty string")
    for key in INTEGER_KEYS:
        value = manifest.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"protocol.json {key} must be a positive integer")
    return manifest


def python_source(manifest: dict[str, Any]) -> str:
    lines = [
        '"""Generated protocol limits. Do not edit by hand."""',
        "",
        f"PROTOCOL_VERSION = {json.dumps(manifest['version'])}",
    ]
    lines.extend(f"{key.upper()} = {manifest[key]}" for key in INTEGER_KEYS)
    return "\n".join(lines) + "\n"


def rust_source(manifest: dict[str, Any]) -> str:
    lines = [
        "// Generated protocol limits. Do not edit by hand.",
        f'pub const PROTOCOL_VERSION: &str = "{manifest["version"]}";',
    ]
    lines.extend(f"pub const {key.upper()}: usize = {manifest[key]};" for key in INTEGER_KEYS)
    return "\n".join(lines) + "\n"


def typescript_source(manifest: dict[str, Any]) -> str:
    lines = [
        "// Generated protocol limits. Do not edit by hand.",
        f"export const PROTOCOL_VERSION = {json.dumps(manifest['version'])} as const;",
    ]
    lines.extend(f"export const {key.upper()} = {manifest[key]} as const;" for key in INTEGER_KEYS)
    return "\n".join(lines) + "\n"


def main() -> None:
    reexec_with_local_venv(ROOT, "PROTOCOL_GEN_REEXEC", (ROOT / ".venv", ROOT / "venv"))
    manifest = load_manifest()
    outputs = {
        PYTHON_OUTPUT: python_source(manifest),
        RUST_OUTPUT: rust_source(manifest),
        TYPESCRIPT_OUTPUT: typescript_source(manifest),
    }
    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        print(f"Generated {path}")


if __name__ == "__main__":
    main()
