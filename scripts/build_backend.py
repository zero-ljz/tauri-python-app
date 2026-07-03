from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_MAIN = ROOT / "backend" / "main.py"
BIN_DIR = ROOT / "src-tauri" / "bin"
BUILD_DIR = ROOT / "build" / "pyinstaller"


def venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def local_venv_python() -> Path | None:
    for venv_dir in (ROOT / ".venv", ROOT / "src-tauri" / ".venv", ROOT / "venv", ROOT / "src-tauri" / "venv"):
        python = venv_python(venv_dir)
        if python.is_file():
            return python
    return None


def reexec_with_local_venv() -> None:
    if os.environ.get("BACKEND_BUILD_REEXEC") == "1":
        return

    python = local_venv_python()
    if python is None:
        return

    current = Path(sys.executable).resolve()
    if current == python.resolve():
        return

    env = os.environ.copy()
    env["BACKEND_BUILD_REEXEC"] = "1"
    completed = subprocess.run([str(python), *sys.argv], cwd=ROOT, env=env)
    raise SystemExit(completed.returncode)


def rust_host_triple() -> str | None:
    try:
        output = subprocess.check_output(
            ["rustc", "-vV"],
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            stderr=subprocess.STDOUT,
        )
    except (OSError, subprocess.CalledProcessError):
        return None

    for line in output.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    return None


def fallback_target() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = "aarch64" if machine in {"arm64", "aarch64"} else "x86_64"

    if system == "windows":
        return f"{arch}-pc-windows-msvc"
    if system == "darwin":
        return f"{arch}-apple-darwin"
    if system == "linux":
        return f"{arch}-unknown-linux-gnu"

    raise RuntimeError(f"无法推断当前平台的 Rust target triple: {system}/{machine}")


def resolve_target(cli_target: str | None) -> str:
    return (
        cli_target
        or os.environ.get("CARGO_BUILD_TARGET")
        or os.environ.get("TARGET")
        or rust_host_triple()
        or fallback_target()
    )


def executable_name(target: str) -> str:
    suffix = ".exe" if "windows" in target else ""
    return f"backend-{target}{suffix}"


def run_pyinstaller(target: str) -> Path:
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    name = f"backend-{target}"
    output = BIN_DIR / executable_name(target)
    if output.exists():
        output.unlink()

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--console",
        "--name",
        name,
        "--distpath",
        str(BIN_DIR),
        "--workpath",
        str(BUILD_DIR / "work"),
        "--specpath",
        str(BUILD_DIR / "spec"),
        str(BACKEND_MAIN),
    ]

    try:
        subprocess.run(command, cwd=ROOT, check=True)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.returncode) from exc

    if not output.exists():
        raise RuntimeError(f"PyInstaller 未生成期望的 backend 文件: {output}")
    return output


def main() -> None:
    reexec_with_local_venv()

    parser = argparse.ArgumentParser(description="Build the Python backend binary for Tauri.")
    parser.add_argument(
        "--target",
        help="Rust target triple, e.g. x86_64-pc-windows-msvc. Defaults to rustc host.",
    )
    parser.add_argument(
        "--clean-cache",
        action="store_true",
        help="Remove the PyInstaller work directory before building.",
    )
    args = parser.parse_args()

    if not BACKEND_MAIN.exists():
        raise RuntimeError(f"找不到 backend 入口: {BACKEND_MAIN}")

    if args.clean_cache and BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)

    target = resolve_target(args.target)
    output = run_pyinstaller(target)
    print(f"Built backend: {output}")


if __name__ == "__main__":
    main()
