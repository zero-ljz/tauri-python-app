from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from ._python_env import reexec_with_local_venv
except ImportError:
    from _python_env import reexec_with_local_venv


ROOT = Path(__file__).resolve().parents[1]
GENERATED_FILES = (
    ROOT / "backend" / "protocol_config.py",
    ROOT / "src-tauri" / "src" / "protocol_config.rs",
    ROOT / "src" / "types" / "protocol.ts",
    ROOT / "src" / "types" / "generated.ts",
)
PYTHON_LOCKS = (ROOT / "backend" / "requirements.txt", ROOT / "requirements-dev.txt")


def digest(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def run(*command: str) -> None:
    executable = shutil.which(command[0])
    if executable is None:
        raise RuntimeError(f"Required executable was not found on PATH: {command[0]}")
    resolved_command = (executable, *command[1:])
    print(f"\n> {' '.join(command)}", flush=True)
    subprocess.run(resolved_command, cwd=ROOT, check=True)


def validate_python_locks() -> None:
    for path in PYTHON_LOCKS:
        contents = path.read_text(encoding="utf-8")
        if "--index-url" in contents or "--extra-index-url" in contents:
            raise SystemExit(f"Python lock embeds a package index: {path.relative_to(ROOT)}")
        if "--hash=sha256:" not in contents:
            raise SystemExit(f"Python lock is missing hashes: {path.relative_to(ROOT)}")

    dev_lock = PYTHON_LOCKS[1].read_text(encoding="utf-8")
    required_markers = (
        ("macholib", "sys_platform == 'darwin'"),
        ("pefile", "sys_platform == 'win32'"),
        ("pywin32-ctypes", "sys_platform == 'win32'"),
    )
    for package, marker in required_markers:
        if package not in dev_lock or marker not in dev_lock:
            raise SystemExit(f"Universal Python lock is missing {package!r} with marker {marker!r}")


def main() -> None:
    reexec_with_local_venv(ROOT, "PROJECT_CHECK_REEXEC", (ROOT / ".venv", ROOT / "venv"))
    generated_before = {path: digest(path) for path in GENERATED_FILES}
    run("pnpm", "generate")
    generated_after = {path: digest(path) for path in GENERATED_FILES}
    drift = [
        str(path.relative_to(ROOT))
        for path in GENERATED_FILES
        if generated_before[path] != generated_after[path]
    ]
    if drift:
        raise SystemExit(f"Generated files were stale: {', '.join(drift)}")

    validate_python_locks()
    run(sys.executable, "scripts/sync_version.py", "--check")
    run("pnpm", "typecheck")
    run("pnpm", "exec", "biome", "check", "src", "vite.config.ts", "vitest.config.ts")
    run(sys.executable, "-m", "ruff", "format", "--check", "backend", "scripts", "tests")
    run(sys.executable, "-m", "ruff", "check", "backend", "scripts", "tests")
    run("pnpm", "exec", "pyright")
    run("pnpm", "exec", "vitest", "run")
    run(sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v")
    run("cargo", "fmt", "--manifest-path", "src-tauri/Cargo.toml", "--check")
    run(
        "cargo",
        "clippy",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--all-targets",
        "--all-features",
        "--",
        "-D",
        "warnings",
    )
    run("cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--all-features")
    print("\nAll quality checks passed.")


if __name__ == "__main__":
    main()
